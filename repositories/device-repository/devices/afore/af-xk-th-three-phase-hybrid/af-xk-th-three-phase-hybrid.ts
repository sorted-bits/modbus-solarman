/*
 * Created on Wed Mar 20 2024
 * Copyright © 2024 Wim Haanstra
 *
 * Non-commercial use only
 */

import { Logger, NumberAttribute, SelectAttribute } from 'quantumhub-sdk';
import { IAPI, IAPI2 } from '../../../../../api/iapi';
import { Brand } from '../../../models/enum/brand';
import { bufferForDataType } from '../../../models/enum/register-datatype';
import { RegisterType } from '../../../models/enum/register-type';
import { ModbusDevice } from '../../../models/modbus-device';
import { holdingRegisters } from './holding-registers';
import { inputRegisters } from './input-registers';

export class AforeAFXKTH extends ModbusDevice {
  constructor() {
    super(
      'af-xk-th-three-phase-hybrid',
      Brand.Afore,
      'BlauHoff AF XK-TH',
      'BlauHoff Afore AF XK-TH Three Phase Hybrid Inverter Series'
    );

    this.supportsSolarman = true;
    this.deprecatedCapabilities = ['status_text.batter_state'];

    this.supportedFlows = {
      actions: {
        set_charge_command: this.setChargeCommand,
        write_value_to_register: this.writeValueToRegister,
        set_ac_charging_timeslot: this.setAcChargingTimeslot,
        set_timing_ac_charge_off: this.setTimingAcChargeOff,
        set_timing_ac_charge_on: this.setTimingAcChargeOn,
      },
    };

    this.registerUpdates = {
      "ems_mode": this.setEmsMode,
      "measure_power_charge_instructions": this.setChargeValue
    }

    this.addInputRegisters(inputRegisters);
    this.addHoldingRegisters(holdingRegisters);
  }

  writeValueToRegister = async (origin: Logger, args: any, client: IAPI): Promise<void> => {
    client.writeValueToRegister(args);
  };

  setNumberValue = async (log: Logger, args: { attribute: SelectAttribute, value: string }, client: IAPI2): Promise<void> => {
    const register = this.getRegisterByTypeAndKey(RegisterType.Holding, args.attribute.key);

    if (register === undefined) {
      log.error('Register not found');
      return;
    }
  }

  setChargeCommand = async (origin: Logger, args: any, client: IAPI): Promise<void> => {
    const emsRegister = this.getRegisterByTypeAndAddress(RegisterType.Holding, 2500);
    const commandRegister = this.getRegisterByTypeAndAddress(RegisterType.Holding, 2501);
    const powerRegister = this.getRegisterByTypeAndAddress(RegisterType.Holding, 2502);

    if (commandRegister === undefined || powerRegister === undefined || emsRegister === undefined) {
      origin.error('Register not found');
      return;
    }

    const { value, charge_command } = args;

    if (value < -22000 || value > 22000) {
      origin.error('Value out of range');
      return;
    }

    const commandValue = charge_command === 'charge' ? '00aa' : '00bb';
    const commandBuffer = Buffer.from(commandValue, 'hex');
    const powerBuffer = bufferForDataType(powerRegister.dataType, value);

    origin.info('Setting charge command', commandBuffer, 'and power', powerBuffer);

    try {
      const powerOutput = await client.writeBufferRegister(powerRegister, powerBuffer);
      const commandOutput = await client.writeBufferRegister(commandRegister, commandBuffer);
      const emsModeOutput = await client.writeRegister(emsRegister, 4);

      origin.trace('Command and power output', emsModeOutput, commandOutput, powerOutput);
    } catch (error) {
      origin.error('Error writing to register', error);
    }
  };

  setChargeValue = async (log: Logger, args: { attribute: NumberAttribute, value: number }, client: IAPI2): Promise<void> => {
    const register = this.getRegisterByTypeAndAddress(RegisterType.Holding, 2502);

    if (register === undefined) {
      log.error('Register not found');
      return;
    }

    if (isNaN(args.value) || args.value < -22000 || args.value > 22000) {
      log.error('Value is out of bounds', args.value)
      return;
    }

    const powerBuffer = bufferForDataType(register.dataType, args.value);

    log.info('Setting Charge value to', args.value);
    try {
      const powerOutput = await client.writeBufferRegister(register, powerBuffer);
      log.trace('setChargeValue output:', powerOutput);
    } catch (error) {
      log.error('Error writing to register', error);
    }
  }

  setEmsMode = async (log: Logger, args: { attribute: SelectAttribute, value: string }, client: IAPI2): Promise<void> => {
    const emsRegister = this.getRegisterByTypeAndAddress(RegisterType.Holding, 2500);

    if (emsRegister === undefined) {
      log.error('Register not found');
      return;
    }

    const mode = args.attribute.options.indexOf(args.value);
    if (mode === -1) {
      log.error(`Can't find option index`, mode);
      return;
    }

    log.info('Setting EMS mode to', mode, args.value);

    try {
      const emsModeOutput = await client.writeRegister(emsRegister, mode);
      log.trace('setEmsModeOutput', emsModeOutput);
    } catch (error) {
      log.error('Error writing to register', error);
    }
  };

  setAcChargingTimeslot = async (origin: Logger, args: any, client: IAPI): Promise<void> => {
    const { timeslot, starttime, endtime } = args;
    if (timeslot < 1 || timeslot > 4) {
      origin.error('Value out of range');
      return;
    }

    if (!starttime || !endtime) {
      origin.error('Start or end time not provided');
      return;
    }

    const timeToBuffer = (time: string): Buffer => {
      const [hours, minutes] = time.split(':');
      const buffer = Buffer.from([parseInt(hours), parseInt(minutes)]);
      return buffer;
    };

    const startAddress = 2509 + (timeslot - 1) * 2;
    const endAddress = 2510 + (timeslot - 1) * 2;

    const startBuffer = timeToBuffer(starttime);
    const endBuffer = timeToBuffer(endtime);

    const startRegister = this.getRegisterByTypeAndAddress(RegisterType.Holding, startAddress);
    const endRegister = this.getRegisterByTypeAndAddress(RegisterType.Holding, endAddress);

    if (startRegister === undefined || endRegister === undefined) {
      origin.error('Register not found');
      return;
    }

    try {
      const startOutput = await client.writeBufferRegister(startRegister, startBuffer);
      const endOutput = await client.writeBufferRegister(endRegister, endBuffer);

      origin.info('Start and end time output', startOutput, endOutput);
    } catch (error) {
      origin.error('Error writing to register', error);
    }
  };

  setTimingAcChargeOff = async (origin: Logger, args: any, client: IAPI): Promise<void> => {
    const register = this.getRegisterByTypeAndAddress(RegisterType.Holding, 206);

    if (register === undefined) {
      origin.error('Register not found');
      return;
    }

    try {
      const output = await client.writeBitsToRegister(register, [0], 4);
      origin.trace('Output', output);
    } catch (error) {
      origin.error('Error writing to register', error);
    }
  };

  setTimingAcChargeOn = async (origin: Logger, args: any, client: IAPI): Promise<void> => {
    const enabledRegister = this.getRegisterByTypeAndAddress(RegisterType.Holding, 206);
    const acpchgmaxRegister = this.getRegisterByTypeAndAddress(RegisterType.Holding, 2504);
    const acsocmaxchgRegister = this.getRegisterByTypeAndAddress(RegisterType.Holding, 2505);

    if (enabledRegister === undefined || acpchgmaxRegister === undefined || acsocmaxchgRegister === undefined) {
      origin.error('Register not found');
      return;
    }

    const { acpchgmax, acsocmaxchg } = args;

    if (acpchgmax < 0 || acpchgmax > 100 || acsocmaxchg < 0 || acsocmaxchg > 100) {
      origin.error('Value out of range');
      return;
    }

    try {
      const output = await client.writeBitsToRegister(enabledRegister, [1], 4);

      const acpchgmaxOutput = await client.writeRegister(
        acpchgmaxRegister,
        acpchgmaxRegister.calculatePayload(acpchgmax, origin)
      );
      const acsocmaxchgOutput = await client.writeRegister(
        acsocmaxchgRegister,
        acsocmaxchgRegister.calculatePayload(acsocmaxchg, origin)
      );

      origin.trace('Output', output, acpchgmaxOutput, acsocmaxchgOutput);
    } catch (error) {
      origin.error('Error writing to register', error);
    }
  };
}
