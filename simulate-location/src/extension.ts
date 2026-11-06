import { simulatedLocation, type SimulatedLocation } from "@swipt/api/device";
import { defineAction, defineExtension, type Schema } from "@swipt/api/swiplet";

const jsonSchema = {
  type: ["object", "null"],
  properties: {
    latitude: { type: "number" },
    longitude: { type: "number" },
  },
  required: ["latitude", "longitude"],
  additionalProperties: false,
};

const location: Schema<SimulatedLocation | null> = {
  "~standard": {
    version: 1,
    vendor: "simulate-location",
    validate: (value) => ({ value: value as SimulatedLocation | null }),
    jsonSchema: {
      input: () => jsonSchema,
      output: () => jsonSchema,
    },
  },
};

export default defineExtension({
  actions: {
    get: defineAction({
      title: "Get the Simulated Location",
      run: (_, { signal }) => simulatedLocation.get({ signal }),
    }),
    set: defineAction({
      title: "Set the Simulated Location",
      input: location,
      run: (value, { signal }) => simulatedLocation.set(value, { signal }),
    }),
  },
});
