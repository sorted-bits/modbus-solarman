import { Attribute, BaseAttributeWithState, Device, NumberAttribute, Provider, SelectAttribute } from 'quantumhub-sdk';
import { IAPI2, RegisterOutput } from './api/iapi';
import { DeviceRepository } from './repositories/device-repository/device-repository';
import { ModbusDevice } from './repositories/device-repository/models/modbus-device';
import { DateTime } from 'luxon';
import { delay } from './helpers/delay';
import { ModbusAPI2 } from './api/modbus/modbus-api2';
import { RegisterType } from './repositories/device-repository/models/enum/register-type';

const DEFAULT_UNAVAILABLE_TIMEOUT = 180; // 3 minutes of no data marks the device as unavailable
const DEFAULT_UNAVAILABLE_RECONNECT_TIMEOUT = 21600 // 6 hours of no data reconnects the device

class ModbusSolarman implements Device {
  private provider!: Provider;

  private api?: IAPI2;
  private availability: boolean = false;
  private device!: ModbusDevice;
  private runningRequest: boolean = false;
  private isStopping: boolean = false;

  private readRegisterTimeout: undefined | ReturnType<typeof setTimeout>;
  private availabilityTimeoutId: undefined | ReturnType<typeof setTimeout>;

  private lastSuccessfullRead?: DateTime;
  private lastRestart?: DateTime;

  get isAvailable(): boolean {
    const { unavailable_timeout } = this.provider.getConfig();
    if (this.lastSuccessfullRead) {
      const diff = DateTime.now().diff(this.lastSuccessfullRead, 'seconds').seconds;
      return (diff < (unavailable_timeout ?? DEFAULT_UNAVAILABLE_TIMEOUT));
    }
    return false;
  }

  availabilityTimeout = async () => {
    const { unavailable_reconnect_timeout } = this.provider.getConfig();

    let restarting = false;

    await this.setAvailability(this.isAvailable, true);

    if (!this.isAvailable && this.lastRestart) {

      const diff = DateTime.now().diff(this.lastRestart, 'minutes').minutes;

      if (diff === (unavailable_reconnect_timeout ?? DEFAULT_UNAVAILABLE_RECONNECT_TIMEOUT)) {
        restarting = true;
        await this.provider.restart();
      }

    }

    if (!restarting) {
      this.availabilityTimeoutId = this.provider.timeout.set(async () => {
        await this.availabilityTimeout();
      }, 5000);
    }
  }

  updateLastSuccesfullRead = async () => {
    this.lastSuccessfullRead = DateTime.now();
    this.lastRestart = DateTime.now();

    this.provider.cache.set('lastSuccessfullRead', this.lastSuccessfullRead.toISO())
    this.provider.cache.set('lastReconnect', this.lastRestart.toISO());
  }

  init = async (provider: Provider): Promise<boolean> => {
    this.provider = provider;

    await this.setAvailability(this.isAvailable, true);

    const { device, host, port, unitId, solarman, serial } = this.provider.getConfig();

    this.device = DeviceRepository.getInstance().getDeviceById(device) as ModbusDevice;

    if (!this.device) {
      this.provider.logger.error('Device not found');
      return false;
    }

    this.provider.logger.trace('Initializing ', this.device.name);

    this.api = new ModbusAPI2(device, {
      host,
      port,
      unitId,
    }, this.provider.logger);

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

    return true;
  };

  setAvailability = async (availability: boolean, force: boolean = false): Promise<void> => {
    if (this.availability !== availability || force) {
      this.availability = availability;
      await this.provider.setAvailability(this.availability);
    }
  };

  start = async (): Promise<void> => {
    this.isStopping = false;

    this.provider.logger.info('Starting ModbusSolarman');

    if (this.availabilityTimeoutId) {
      this.provider.timeout.clear(this.availabilityTimeoutId);
    }

    this.availabilityTimeout();

    this.readRegisters();
  };

  onSelectChanged = async (attribute: SelectAttribute, value: string): Promise<void> => {
    return await this.valueChanged(attribute, value);
  };

  onNumberChanged = async (attribute: NumberAttribute, value: any): Promise<void> => {
    return await this.valueChanged(attribute, value);
  }

  valueChanged = async (attribute: Attribute, value: any): Promise<void> => {
    this.provider.logger.trace(`Attribute ${attribute.key} changed to ${value}`);

    const key = attribute.key;
    const updateMethod = this.device.registerUpdates[key];

    if (updateMethod) {
      updateMethod(this.provider.logger, {
        value: value,
        attribute: attribute,
      }, this.api!)
    } else {
      this.provider.logger.warn('No update method found for', attribute.key);
    }
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

    this.provider.logger.trace('cleanUp: Waiting for runningRequest to turn false');
    while (this.runningRequest) {
      await delay(1000);
    }
    this.provider.logger.trace('cleanUp: runningRequest is false');
  };

  private handleResults = async (registerValues: RegisterOutput[]) => {
    for (const registerValue of registerValues) {
      const parseConfiguration = registerValue.parseConfiguration;

      const result = parseConfiguration.calculateValue(registerValue.value, registerValue.buffer, this.provider.logger);

      const validationResult = parseConfiguration.validateValue(result, this.provider.logger);
      const attribute = this.provider.getAttribute(parseConfiguration.capabilityId) as BaseAttributeWithState;

      if (validationResult.valid && attribute) {
        await this.provider.setAttributeState(attribute, { state: result });
        parseConfiguration.currentValue = result;
      } else {
        this.provider.logger.error('Invalid value received', registerValue);
      }
    }

    if (registerValues.length > 0) {
      await this.updateLastSuccesfullRead();
    }
  }

  private readRegisters = async (): Promise<void> => {
    if (this.readRegisterTimeout) {
      this.provider.timeout.clear(this.readRegisterTimeout);
      this.readRegisterTimeout = undefined;
    }

    if (!this.api) {
      this.provider.logger.error('ModbusAPI is not initialized');
      return;
    }

    const { updateInterval } = this.provider.getConfig();

    while (this.runningRequest) {
      await delay(1000);
    }

    this.runningRequest = true;
    try {
      const results = await this.api.readRegisters();
      await this.handleResults(results);
    } catch (error: Error | any) {
      if (error.name === 'TransactionTimedOutError') {
        this.provider.logger.warn('Transaction timed out');
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
        this.readRegisterTimeout = this.provider.timeout.set(this.readRegisters.bind(this), interval);
      }
    }
  };

}

export default ModbusSolarman;
