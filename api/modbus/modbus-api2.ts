import ModbusRTU from "modbus-serial";
import { DeviceRepository } from "../../repositories/device-repository/device-repository";
import { ModbusDevice } from "../../repositories/device-repository/models/modbus-device";
import { IAPI2, RegisterOutput } from "../iapi";
import { Logger } from 'quantumhub-sdk';
import { createRegisterBatches } from "../../repositories/device-repository/helpers/register-batches";
import { ModbusRegister } from "../../repositories/device-repository/models/modbus-register";
import { RegisterType } from "../../repositories/device-repository/models/enum/register-type";
import { validateValue } from "../../helpers/validate-value";
import { AccessMode } from "../../repositories/device-repository/models/enum/access-mode";
import { delay } from "../../helpers/delay";
import { logBits, writeBitsToBuffer } from "../../helpers/bits";

export interface ModbusConnectionOptions {
    host: string;
    port: number;
    unitId: number;
    timeout?: number;
}

export class ModbusAPI2 implements IAPI2 {

    private device: ModbusDevice;
    private busy: boolean = false;

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
        await this.waitInQueue('readRegisters');
        const results: Array<RegisterOutput> = [];

        let client: ModbusRTU | undefined = undefined;
        try {
            client = await this.connect();
            const inputBatches = createRegisterBatches(this.log, this.device.inputRegisters);
            const holdingBatches = createRegisterBatches(this.log, this.device.holdingRegisters);

            for (const batch of inputBatches) {
                try {
                    const result = await this.readBatch(client, batch, RegisterType.Input);
                    results.push(...result);
                }
                catch (error) {
                    this.log.error('readRegister input error', error);
                }
            }

            for (const batch of holdingBatches) {
                try {
                    const result = await this.readBatch(client, batch, RegisterType.Holding);
                    results.push(...result);
                } catch (error) {
                    this.log.error('readRegister holding error', error);
                }
            }
        } catch (error) {
            this.log.error('readRegisters error', error);
        } finally {
            this.busy = false;

            client?.close(() => {
                this.log.trace('Closing Modbus connection');
            });
        }

        return results;
    }

    writeRegisters = async (register: ModbusRegister, values: any[]): Promise<boolean> => {
        if (register.accessMode === AccessMode.ReadOnly) {
            return false;
        }

        for (const value of values) {
            if (!Buffer.isBuffer(value)) {
                const valid = validateValue(value, register.dataType);
                this.log.trace('Validating value', value, 'for register', register.address, 'with data type', register.dataType, 'result', valid);

                if (!valid) {
                    return false;
                }
            }
        }

        this.log.trace('Writing to address', register.address, ':', values);

        await this.waitInQueue('writeRegisters');

        const client = await this.connect();

        try {
            const result = await client.writeRegisters(register.address, values);
            this.log.trace('Output', result.address);
            return true;
        } catch (error) {
            this.log.error('Error writing to register', error);
            return false;
        } finally {
            client.close(() => {
                this.busy = false;
                this.log.trace('Closing modbus connection');
            });
        }
    };

    /**
     * Writes bits to a Modbus register.
     *
     * This method first reads the current value of the register. If the read operation fails, an error is logged and the method returns false.
     * It then checks if the bit index is within the range of the register. If it is not, an error is logged and the method returns false.
     * The method then calculates the byte index and the start bit index within the byte.
     * It then writes the bits to the buffer at the calculated indices.
     * Finally, it writes the buffer back to the register.
     *
     * @param register - The Modbus register to write to.
     * @param registerType - The type of the register.
     * @param bits - The bits to write.
     * @param bitIndex - The index at which to start writing the bits.
     * @returns A promise that resolves to a boolean indicating whether the write operation was successful.
     */
    writeBitsToRegister = async (register: ModbusRegister, bits: number[], bitIndex: number): Promise<boolean> => {
        try {
            const client = await this.connect();

            var readBuffer: Buffer | undefined = await this.readAddressWithoutConversionWithRetries(client, register, 5);

            if (readBuffer === undefined) {
                this.log.error('Failed to read current value');
                return false;
            }
        } catch (error) {
            this.log.error('Error reading current value', error);
            return false;
        }

        try {
            logBits(this.log, readBuffer);

            if (readBuffer.length * 8 < bitIndex + bits.length) {
                this.log.error('Bit index out of range');
                return false;
            }

            const byteIndex = readBuffer.length - 1 - Math.floor(bitIndex / 8);
            const startBitIndex = bitIndex % 8;

            this.log.trace('writeBitsToRegister', register.registerType, bits, startBitIndex, byteIndex);

            const result = writeBitsToBuffer(readBuffer, byteIndex, bits, startBitIndex);
            logBits(this.log, result);

            await this.writeBufferRegister(register, result);
            return true;
        } catch (error) {
            return true;
        } finally {
            this.busy = false;
        }
    };

    /**
     * Writes a value to a Modbus register.
     *
     * This method first checks if the register is read-only. If it is, the method returns false.
     * It then validates the value to be written using the `validateValue` function. If the value is invalid, an error is logged and the method returns false.
     * The method then attempts to write the value to the register. If the write operation fails, an error is logged and the method returns false.
     * If the write operation is successful, the method returns true.
     *
     * @param register - The Modbus register to write to.
     * @param value - The value to write.
     * @returns A promise that resolves to a boolean indicating whether the write operation was successful.
     */
    writeRegister = async (register: ModbusRegister, value: any): Promise<boolean> => {
        return this.writeRegisters(register, [value]);
    };

    /**
     * Writes a buffer to a Modbus register.
     *
     * This method first checks if the register is read-only. If it is, the method returns false.
     * The method then logs the buffer to be written and attempts to write the buffer to the register.
     * If the write operation fails, an error is logged and the method returns false.
     * If the write operation is successful, the method returns true.
     *
     * @param register - The Modbus register to write to.
     * @param buffer - The buffer to write.
     * @returns A promise that resolves to a boolean indicating whether the write operation was successful.
     */
    writeBufferRegister = async (register: ModbusRegister, buffer: Buffer): Promise<boolean> => {
        this.log.trace('Writing to register', register.address, buffer, typeof buffer);

        await this.waitInQueue('writeBufferRegister');

        const client = await this.connect();
        try {
            const result = await client.writeRegisters(register.address, buffer);
            this.log.trace('Output', result.address);
        } catch (error) {
            this.log.error('Error writing to register', error);
            return false;
        } finally {
            client.close(() => {
                this.busy = false;
                this.log.trace('Closing modbus connection');
            });
        }

        return true;
    };


    private connect = async (): Promise<ModbusRTU> => {
        const client = new ModbusRTU();

        const { host, port, timeout, unitId } = this.connection;
        const timeoutValue = timeout ?? 5000;


        this.log.trace('Connecting to Modbus device', host, port, timeoutValue, unitId);

        await client.connectTCP(host, {
            port,
            keepAlive: true,
            timeout: timeoutValue
        });

        client.setID(unitId);
        client.setTimeout(timeoutValue);

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

    /**
  /**
   * Reads a Modbus register without converting the data.
   *
   * @param register - The Modbus register to read.
   * @param registerType - The type of the register.
   * @returns A promise that resolves to the read data or undefined if the read operation failed.
   */
    readAddressWithoutConversion = async (client: ModbusRTU, register: ModbusRegister): Promise<Buffer | undefined> => {
        await this.waitInQueue('readRegisters');

        try {
            const data = register.registerType === RegisterType.Input ? await client.readInputRegisters(register.address, register.length) : await client.readHoldingRegisters(register.address, register.length);

            this.log.trace('Reading address', register.address, ':', data);

            if (data && data.buffer) {
                return data.buffer;
            }

            return undefined;
        } catch (error) {
            this.log.error('Error reading address', register.address, JSON.stringify(error));
            return undefined;
        } finally {
            this.busy = false;
        }
    };

    private readAddressWithoutConversionWithRetries = async (client: ModbusRTU, register: ModbusRegister, retries: number): Promise<Buffer | undefined> => {
        let result: Buffer | undefined = undefined;

        for (let i = 0; i < retries; i++) {
            result = await this.readAddressWithoutConversion(client, register);

            if (result !== undefined) {
                break;
            }

            this.log.error('Failed to read address', register.address, 'retrying', i + 1);

            await delay(1000);
        }

        return result;
    }

    private waitInQueue = async (command: string) => {
        let output = false;

        while (this.busy) {
            if (!output) {
                this.log.trace(`Waiting in queue for ${command}`);
                output = true;
            }

            await delay(500);
        }

        this.log.trace(`Starting ${command}`);

        this.busy = true;
    }
}