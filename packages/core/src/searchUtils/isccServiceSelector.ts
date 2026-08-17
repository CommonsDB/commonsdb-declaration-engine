import { Config } from "sst/node/config";

/**
 * Base URL of the iscc-web service for the current stage. The host is provided
 * per stage via the ISCC_HOST parameter (see stacks/CommonsDBStack.ts).
 */
export const getIsccServiceUrlByConfig = (): string => {
  return Config.ISCC_HOST;
};
