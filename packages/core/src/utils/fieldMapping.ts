import { Config } from "sst/node/config";
import { generateCidFromJson } from "../searchUtils/cidUtil";
import { IDeclarationMetaInternal, IDeclarationPublicMetadata } from "../interfaces/commonInterfaces";

/**
 * Supported field types for mapping
 */
export enum FieldType {
  IDENTIFIER = "IDENTIFIER",
}

export enum IdentifierFieldValuesType {
  CIDV1 = "cidV1",
  CIDV2 = "cidV2",
}

export const ALLOWED_IDENTIFIER_KEYS = [IdentifierFieldValuesType.CIDV1, IdentifierFieldValuesType.CIDV2];

const fieldEnvKeyMap: Record<
  FieldType,
  {
    envName: string;
    allowedValues: IdentifierFieldValuesType[];
    method: (keyName: IdentifierFieldValuesType, data: any) => any;
    generateMethod: (data: any) => any;
  }
> = {
  [FieldType.IDENTIFIER]: {
    envName: "SECRET_IDENTIFIER_FIELD_KEY_NAME",
    allowedValues: ALLOWED_IDENTIFIER_KEYS,
    method: (keyName: IdentifierFieldValuesType, data: IDeclarationMetaInternal) => data[keyName],
    generateMethod: (data: IDeclarationPublicMetadata) => generateCidFromJson(data),
  },
};

/**
 * Creates a key-value pair for any field type
 * @param fieldType The type of field being mapped
 * @param value The value to be mapped
 * @returns A tuple containing [string, any] where the key is from env and value is the processed value
 */
export function getFieldKeyValuePair<T, Y>(
  fieldType: FieldType,
  value: T,
  valueForGeneration: Y,
): [string, string | null, string | null] {
  const mapping = fieldEnvKeyMap[fieldType];
  if (!mapping) {
    throw new Error(`Unsupported field type: ${fieldType}`);
  }
  //@ts-ignore
  const key = Config[mapping.envName];
  if (!key) {
    throw new Error(`Environment variable ${mapping.envName} not found`);
  }

  if (mapping.allowedValues.length && !mapping.allowedValues.includes(key)) {
    throw new Error(`Invalid key: ${key}`);
  }

  let processedValue: string | null = null;

  if (value) {
    processedValue = mapping.method(key, value);
  }

  let generatedValue: string | null = null;
  if (valueForGeneration) {
    generatedValue = mapping.generateMethod(valueForGeneration);
  }

  return [key, processedValue, generatedValue];
}

/**
 * Creates a key-value pair specifically for identifier fields
 * @param value The value to be mapped
 * @returns A tuple containing [string, any] where the key is from env and value is the processed value
 */
export function getIdentifierKeyValuePair(
  value: IDeclarationMetaInternal = {} as IDeclarationMetaInternal,
  valueForGeneration: IDeclarationPublicMetadata = {} as IDeclarationPublicMetadata,
): [string, string | null, string | null] {
  return getFieldKeyValuePair(FieldType.IDENTIFIER, value, valueForGeneration);
}

/**
 * Creates multiple key-value pairs for different field types
 * @param mappings Array of tuples containing field type and value
 * @returns Object with mapped keys and values
 */
export function getMultipleFieldMappings<T, Y>(
  mappings: Array<[FieldType, T, Y]>,
): Record<string, { value: string | null; generatedValue: string | null }> {
  return mappings.reduce((acc, [fieldType, value, valueForGeneration]) => {
    const [key, mappedValue, generatedValue] = getFieldKeyValuePair(fieldType, value, valueForGeneration);
    return { ...acc, [key]: { value: mappedValue, generatedValue } };
  }, {});
}
