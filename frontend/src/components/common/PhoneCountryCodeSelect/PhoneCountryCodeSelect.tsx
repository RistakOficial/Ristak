import React from 'react'
import { getCountryDefaults, getPhoneCountryOptions } from '@/utils/accountLocale'
import { CustomSelect } from '../CustomSelect'

const PHONE_COUNTRY_CODE_OPTIONS = getPhoneCountryOptions().map(({ value, label }) => ({
  value,
  label
}))

export interface PhoneCountryCodeSelectProps {
  value?: string
  defaultValue?: string
  onValueChange?: (countryCode: string) => void
  className?: string
  disabled?: boolean
  id?: string
  name?: string
  required?: boolean
  portal?: boolean
  'aria-label'?: string
  'aria-labelledby'?: string
}

export const PhoneCountryCodeSelect: React.FC<PhoneCountryCodeSelectProps> = ({
  value,
  defaultValue,
  onValueChange,
  className,
  disabled,
  id,
  name,
  required,
  portal,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy
}) => {
  const selectedCountry = getCountryDefaults(value ?? defaultValue)

  return (
    <CustomSelect
      options={PHONE_COUNTRY_CODE_OPTIONS}
      value={value}
      defaultValue={defaultValue}
      onValueChange={onValueChange}
      className={className}
      disabled={disabled}
      id={id}
      name={name}
      required={required}
      portal={portal}
      dropdownMinWidth={120}
      aria-label={ariaLabel || `Código telefónico internacional +${selectedCountry.dialCode}`}
      aria-labelledby={ariaLabelledBy}
    />
  )
}
