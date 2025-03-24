import { Logger } from 'quantumhub-sdk';
import { IAPI2 } from '../../../api/iapi';

export enum SupportedFlowTypes {
  set_max_solar_power = 'set_max_solar_power',
  set_solar_sell = 'set_solar_sell',
  set_max_sell_power = 'set_max_sell_power',
  write_value_to_register = 'write_value_to_register',
  set_energy_pattern = 'set_energy_pattern',
  set_grid_peak_shaving_on = 'set_grid_peak_shaving_on',
  set_grid_peak_shaving_off = 'set_grid_peak_shaving_off',
  set_work_mode_and_zero_export_power = 'set_work_mode_and_zero_export_power',
  set_time_of_use_enabled = 'set_time_of_use_enabled',
  set_time_of_use_day_enabled = 'set_time_of_use_day_enabled',
  set_time_of_use_timeslot_parameters = 'set_time_of_use_timeslot_parameters',
  set_charge_command = 'set_charge_command',
  set_ems_mode = 'set_ems_mode',
  set_ac_charging_timeslot = 'set_ac_charging_timeslot',
  set_timing_ac_charge_off = 'set_timing_ac_charge_off',
  set_timing_ac_charge_on = 'set_timing_ac_charge_on',
  set_all_timeslot_parameters = 'set_all_timeslot_parameters',
}

export const getSupportedFlowTypes = (): string[] => {
  return Object.keys(SupportedFlowTypes).map(
    (key: string) => SupportedFlowTypes[key as keyof typeof SupportedFlowTypes]
  );
};

export const getSupportedFlowTypeKeys = (): SupportedFlowTypes[] => {
  return Object.keys(SupportedFlowTypes).map(
    (key: string) => SupportedFlowTypes[key as keyof typeof SupportedFlowTypes]
  );
};

export interface SupportedFlows {
  actions?: {
    [id in SupportedFlowTypes]?: (
      origin: Logger,
      args: any,
      client: IAPI2
    ) => Promise<void>;
  };
}
