import router from "./index";
import * as prismaExports from "generated/client";
import casual from "casual";
import request from "supertest";
import express from "express";

// Create test application.
const app = express().use(router);

describe("POST /registry_events", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("registry_events are mapped to a deployment upgrade", async () => {
    // Set up our spies.
    const deployment = jest
      .spyOn(prismaExports.prisma, "deployment")
      .mockImplementation(() => {
        return {
          config() {
            return {};
          }
        };
      });

    const updateDeployment = jest
      .spyOn(prismaExports.prisma, "updateDeployment")
      .mockReturnValue({});

    const res = await request(app)
      .post("/")
      .send({
        events: [
          {
            id: casual.uuid,
            action: "push",
            target: {
              repository: "cosmic-dust-1234/airflow",
              tag: "cli-1"
            },
            request: {
              host: casual.domain
            }
          }
        ]
      });

    expect(deployment).toHaveBeenCalledTimes(1);
    expect(updateDeployment).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
  });

  test("skip if irrelevent event is sent", async () => {
    // Set up our spies.
    const deployment = jest.spyOn(prismaExports.prisma, "deployment");

    const updateDeployment = jest.spyOn(
      prismaExports.prisma,
      "updateDeployment"
    );

    const res = await request(app)
      .post("/")
      .send({
        events: [
          {
            id: casual.uuid,
            action: "push",
            target: {
              repository: "cosmic-dust-1234/airflow",
              tag: "latest"
            },
            request: {
              host: casual.domain
            }
          }
        ]
      });

    expect(deployment).toHaveBeenCalledTimes(0);
    expect(updateDeployment).toHaveBeenCalledTimes(0);
    expect(res.statusCode).toBe(200);
  });
});
