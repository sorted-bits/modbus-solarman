import { Attribute, BaseAttributeWithState, Device, Provider, SelectAttribute } from 'quantumhub-sdk';
import { IAPI } from './api/iapi';
import { ModbusAPI } from './api/modbus/modbus-api';
import { Solarman } from './api/solarman/solarman';
import { DeviceRepository } from './repositories/device-repository/device-repository';
import { ModbusDevice } from './repositories/device-repository/models/modbus-device';
import { ModbusRegister, ModbusRegisterParseConfiguration } from './repositories/device-repository/models/modbus-register';
import { DateTime } from 'luxon';

class ModbusSolarman implements Device {
  private provider!: Provider;

  private api?: IAPI;
  private availability: boolean = false;
  private device!: ModbusDevice;
  private runningRequest: boolean = false;
  private isStopping: boolean = false;

  private readRegisterTimeout: undefined | ReturnType<typeof setTimeout>;
  private availabilityTimeoutId: undefined | ReturnType<typeof setTimeout>;

  private lastSuccessfullRead?: DateTime

  get isAvailable(): boolean {
    const { unavailable_timeout } = this.provider.getConfig();
    if (this.lastSuccessfullRead) {
      const diff = DateTime.now().diff(this.lastSuccessfullRead, 'seconds').seconds;
      return (diff < unavailable_timeout);
    }
    return false;
  }

  availabilityTimeout = async () => {
    await this.setAvailability(this.isAvailable);

    this.availabilityTimeoutId = this.provider.timeout.set(async () => {
      await this.availabilityTimeout();
    }, 5000)
  }

  updateLastSuccesfullRead = async () => {
    this.lastSuccessfullRead = DateTime.now();
    this.provider.cache.set('lastSuccessfullRead', this.lastSuccessfullRead.toISO())
  }

  init = async (provider: Provider): Promise<boolean> => {
    this.provider = provider;

    await this.setAvailability(this.isAvailable, true);

    const { device } = this.provider.getConfig();

    this.device = DeviceRepository.getInstance().getDeviceById(device) as ModbusDevice;

    if (!this.device) {
      this.provider.logger.error('Device not found');
      return false;
    }

    this.provider.logger.trace('Initializing ', this.device.name);

    const { lastSuccessfullRead } = await this.provider.cache.all();
    if (lastSuccessfullRead) {
      this.lastSuccessfullRead = DateTime.fromISO(lastSuccessfullRead);
      if (!this.lastSuccessfullRead.isValid) {
        this.provider.logger.error('Could not parse lastSuccessfullRead from cache', lastSuccessfullRead);
        this.lastSuccessfullRead = undefined;
      }
    } else {
      this.provider.logger.warn('No `lastSuccessFullRead` found in cache');
      await this.updateLastSuccesfullRead();
    }

    this.availabilityTimeout();

    return true;
  };

  setAvailability = async (availability: boolean, force: boolean = false): Promise<void> => {
    if (this.availability !== availability || force) {
      this.provider.logger.info('Setting availability:', availability);

      this.availability = availability;
      await this.provider.setAvailability(this.availability);
    }
  };

  start = async (): Promise<void> => {
    this.isStopping = false;

    this.provider.logger.info('Starting ModbusSolarman');

    await this.connect();
  };

  onSelectChanged = async (attribute: SelectAttribute, value: string): Promise<void> => {
    if (attribute.key === 'ems_mode') {
      this.provider.logger.info('EMS mode changed to', value);
    }
  };

  valueChanged = async (attribute: Attribute, value: any): Promise<void> => {
    this.provider.logger.trace(`Attribute ${attribute} changed to ${value}`);
  };

  stop = async (): Promise<void> => {
    this.provider.logger.info('Stopping ModbusSolarman');
    await this.cleanUp();
  };

  destroy = async (): Promise<void> => {
    this.provider.logger.trace('Destroying ModbusSolarman');
    await this.cleanUp();
  };

  private cleanUp = async (): Promise<void> => {
    this.isStopping = true;
    if (this.readRegisterTimeout) {
      this.provider.timeout.clear(this.readRegisterTimeout);
      this.readRegisterTimeout = undefined;
    }

    if (this.availabilityTimeoutId) {
      this.provider.timeout.clear(this.availabilityTimeoutId);
      this.availabilityTimeoutId = undefined;
    }

    if (this.api?.isConnected()) {
      this.provider.logger.trace('Closing modbus connection');
      this.api.disconnect();
    }
  };

  private onError = async (error: unknown, register: ModbusRegister): Promise<void> => {
    if (error && (error as any)['name'] && (error as any)['name'] === 'TransactionTimedOutError') {
      await this.setAvailability(false);
    } else {
      this.provider.logger.error('Request failed', error);
    }
  };

  private onDataReceived = async (value: any, buffer: Buffer, parseConfiguration: ModbusRegisterParseConfiguration) => {
    const result = parseConfiguration.calculateValue(value, buffer, this.provider.logger);

    const validationResult = parseConfiguration.validateValue(result, this.provider.logger);
    const attribute = this.provider.getAttribute(parseConfiguration.capabilityId) as BaseAttributeWithState;

    if (validationResult.valid && attribute) {
      await this.provider.setAttributeState(attribute, { state: result });
      parseConfiguration.currentValue = result;
    } else {
      this.provider.logger.error('Invalid value received', value, buffer);
    }

    await this.updateLastSuccesfullRead();
  };

  private onDisconnect = async (): Promise<void> => {
    this.provider.logger.warn('Disconnected');

    if (this.readRegisterTimeout) {
      this.provider.timeout.clear(this.readRegisterTimeout);
      this.readRegisterTimeout = undefined;
    }

    if (!this.api) {
      return;
    }

    const isOpen = this.api.connect();

    if (!isOpen) {
      this.provider.logger.error('Failed to reconnect, reconnecting in 60 seconds');
      this.readRegisterTimeout = await this.provider.timeout.set(this.onDisconnect.bind(this), 60000);
    } else {
      this.provider.logger.trace('Reconnected to device');
      await this.readRegisters();
    }
  };

  private readRegisters = async (): Promise<void> => {
    if (this.readRegisterTimeout) {
      this.provider.timeout.clear(this.readRegisterTimeout);
      this.readRegisterTimeout = undefined;
    }

    if (!this.api) {
      this.provider.logger.error('ModbusAPI is not initialized');
      return;
    }

    this.provider.logger.trace('Reading registers');

    const { updateInterval, unavailable_timeout } = this.provider.getConfig();

    if (this.runningRequest) {
      this.readRegisterTimeout = this.provider.timeout.set(this.readRegisters.bind(this), 500);
      return;
    }

    this.runningRequest = true;

    try {
      await this.api.readRegistersInBatch();
    } catch (error: Error | any) {
      const currentTime = DateTime.now();

      if (error.name === 'TransactionTimedOutError') {
        if (!this.lastSuccessfullRead) {
          this.lastSuccessfullRead = DateTime.now();
        }
      } else {
        this.provider.logger.error('Failed to read registers', JSON.stringify(error));
      }
    } finally {
      this.runningRequest = false;

      const interval = this.isAvailable ? Math.max(updateInterval, 2) * 1000 : 60000;

      if (!this.isAvailable) {
        this.provider.logger.warn('Device is not reachable, retrying in 60 seconds');
      }

      if (!this.isStopping) {
        const methodToCall = this.api.isConnected() ? this.readRegisters.bind(this) : this.connect.bind(this);
        this.readRegisterTimeout = this.provider.timeout.set(methodToCall, interval);
      }
    }
  };

  connect = async (): Promise<void> => {
    this.runningRequest = false;

    const { host, port, unitId, solarman, serial } = this.provider.getConfig();

    if (this.readRegisterTimeout) {
      this.provider.timeout.clear(this.readRegisterTimeout);
    }

    this.provider.logger.trace(`Connecting to ${host}:${port} with unitId ${unitId} (solarman: ${solarman}, serial: ${serial})`);

    this.api = solarman ? new Solarman(this.provider.logger, this.device, host, serial, 8899, 1) : new ModbusAPI(this.provider.logger, host, port, unitId, this.device);

    this.api?.setOnError(this.onError);
    this.api?.setOnDisconnect(this.onDisconnect);
    this.api?.setOnDataReceived(this.onDataReceived);

    const isOpen = await this.api.connect();

    if (isOpen) {
      await this.readRegisters();
    }
  };
}

export default ModbusSolarman;
