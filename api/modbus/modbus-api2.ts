import ModbusRTU from "modbus-serial";
import { DeviceRepository } from "../../repositories/device-repository/device-repository";
import { ModbusDevice } from "../../repositories/device-repository/models/modbus-device";
import { IAPI2, RegisterOutput } from "../iapi";
import { Logger } from 'quantumhub-sdk';
import { createRegisterBatches } from "../../repositories/device-repository/helpers/register-batches";
import { ModbusRegister } from "../../repositories/device-repository/models/modbus-register";
import { RegisterType } from "../../repositories/device-repository/models/enum/register-type";
import { validateValue } from "../../helpers/validate-value";

export interface ModbusConnectionOptions {
    host: string;
    port: number;
    unitId: number;
    timeout?: number;
}

export class ModbusAPI2 implements IAPI2 {

    private device: ModbusDevice;

    constructor(private deviceId: string, private connection: ModbusConnectionOptions, private log: Logger) {
        const result = DeviceRepository.getInstance().getDeviceById(this.deviceId);

        if (!result) {
            throw new Error(`Device with ID ${deviceId} does not exist`);
        }

        this.device = result;
    }

    getDevice(): ModbusDevice {
        return this.device;
    }

    readRegisters = async (): Promise<Array<RegisterOutput>> => {
        const client = await this.connect();

        const inputBatches = createRegisterBatches(this.log, this.device.inputRegisters);
        const holdingBatches = createRegisterBatches(this.log, this.device.holdingRegisters);

        const results: Array<RegisterOutput> = [];

        for (const batch of inputBatches) {
            try {
                const result = await this.readBatch(client, batch, RegisterType.Input);
                results.push(...result);
            } catch (error) {

            }
        }

        for (const batch of holdingBatches) {
            try {
                const result = await this.readBatch(client, batch, RegisterType.Holding);
                results.push(...result);
            } catch (error) {

            }
        }

        client.close(() => {
            this.log.trace('Closing Modbus connection');
        });

        return results;
    }

    private connect = async (): Promise<ModbusRTU> => {
        const client = new ModbusRTU();

        const { host, port, timeout, unitId } = this.connection;

        this.log.trace('Connecting to Modbus device', host, port, timeout, unitId);

        await client.connectTCP(host, {
            port,
            keepAlive: true,
            timeout: timeout ?? 1000
        });

        client.setID(unitId);
        client.setTimeout(timeout ?? 1000);

        client.on('error', error => {
            this.log.error(error);
        });

        client.on('close', () => {
            this.log.trace('Connection closed');
        });

        if (client.isOpen) {
            this.log.trace('Modbus connection opened');
        }

        return client;
    }

    private readBatch = async (client: ModbusRTU, batch: ModbusRegister[], registerType: RegisterType): Promise<Array<RegisterOutput>> => {
        if (batch.length === 0) {
            return [];
        }

        const result: Array<RegisterOutput> = [];

        const firstRegister = batch[0];
        const lastRegister = batch[batch.length - 1];

        const length = batch.length > 1 ? lastRegister.address + lastRegister.length - firstRegister.address : batch[0].length;

        try {
            const results = registerType === RegisterType.Input ? await client.readInputRegisters(firstRegister.address, length) : await client.readHoldingRegisters(firstRegister.address, length);

            let startOffset = 0;
            for (const register of batch) {
                const end = startOffset + register.length * 2;
                const buffer = batch.length > 1 ? results.buffer.subarray(startOffset, end) : results.buffer;

                const value = this.device.converter(this.log, buffer, register);

                if (validateValue(value, register.dataType)) {
                    for (const parseConfiguration of register.parseConfigurations) {
                        result.push({
                            register,
                            value,
                            buffer,
                            parseConfiguration
                        })
                        // await this.onDataReceived!(value, buffer, parseConfiguration);
                    }
                } else {
                    this.log.error('Invalid value', value, 'for address', register.address, register.dataType);
                }

                startOffset = end;
            }
        } catch (error: any) {
            this.log.warn('Error reading batch', JSON.stringify(error));
            throw error;
        }

        return result;
    };

}