import { SSTConfig } from "sst";
import { API as CommonsDBStack } from "./stacks/CommonsDBStack";
import { IsccStack } from "./stacks/ISCCStack";

export default {
  config(_input) {
    return {
      // NOTE: deploying this app provisions infrastructure under the
      // "commonsdb" app name. The pre-decomposition production deployment ran
      // under a different app name — switching it to this repository is a
      // migration (fresh stacks + data/secret migration), not an in-place
      // update.
      name: "commonsdb",
      region: "eu-central-1",
    };
  },
  stacks(app) {
    app.setDefaultFunctionProps({
      runtime: "nodejs20.x",
    });
    app.stack(IsccStack);
    app.stack(CommonsDBStack);
  },
} satisfies SSTConfig;
