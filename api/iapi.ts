import { ModbusDevice } from '../repositories/device-repository/models/modbus-device';
import { ModbusRegister, ModbusRegisterParseConfiguration } from '../repositories/device-repository/models/modbus-register';

export interface IAPI {
  getDeviceModel(): ModbusDevice;

  setOnDataReceived(onDataReceived: (value: any, buffer: Buffer, parseConfiguration: ModbusRegisterParseConfiguration) => Promise<void>): void;
  setOnError(onError: (error: unknown, register: ModbusRegister) => Promise<void>): void;
  setOnDisconnect(onDisconnect: () => Promise<void>): void;

  readAddress(register: ModbusRegister): Promise<any>;
  readAddressWithoutConversion(register: ModbusRegister): Promise<Buffer | undefined>;
  readRegistersInBatch(): Promise<void>;

  isConnected(): boolean;

  connect(): Promise<boolean>;
  disconnect(): void;

  writeRegister(register: ModbusRegister, value: any): Promise<boolean>;
  writeRegisters(startRegister: ModbusRegister, values: any[]): Promise<boolean>;
  writeValueToRegister(args: any): Promise<void>;
  writeBufferRegister(register: ModbusRegister, buffer: Buffer): Promise<boolean>;
  writeBitsToRegister(register: ModbusRegister, bits: number[], bitIndex: number): Promise<boolean>;
}

export interface RegisterOutput {
  register: ModbusRegister;
  value: any;
  buffer: Buffer;
  parseConfiguration: ModbusRegisterParseConfiguration;
}

export interface IAPI2 {
  getDevice(): ModbusDevice;

  readRegisters(): Promise<Array<RegisterOutput>>;

  writeRegister(register: ModbusRegister, value: any): Promise<boolean>;
  writeRegisters(startRegister: ModbusRegister, values: any[]): Promise<boolean>;
  writeBufferRegister(register: ModbusRegister, buffer: Buffer): Promise<boolean>;

}