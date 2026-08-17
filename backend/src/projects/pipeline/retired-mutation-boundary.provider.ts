import { GoneException, Provider } from "@nestjs/common";
import { PIPELINE_QUEUE } from "./pipeline.types";

const retired = () => {
  throw new GoneException("Legacy local execution is retired. Use the canonical GitHub Actions deployment journey.");
};

export const retiredMutationBoundaryProvider: Provider = {
  provide: PIPELINE_QUEUE,
  useValue: {
    add: retired,
    getJob: retired,
  },
};
