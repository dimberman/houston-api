// eslint-disable-next-line import/extensions
import sampleData from "./sample.json";
import log from "logger";
import createPoller from "pubsub/poller";
import config from "config";
import request from "request-promise-native";
import moment from "moment";

// Use sample data if prom is not enabled
const useSample = !config.get("prometheus.enabled");

// Return sample as a promise
const samplePromise = new Promise(resolve => {
  resolve(...sampleData);
});

// Build the Prometheus request URL
export function buildURI(query) {
  const now = moment().unix() - (moment().unix() % 15);
  const host = config.get("prometheus.host");
  const port = config.get("prometheus.port");
  return `http://${host}:${port}/api/v1/query?query=${encodeURI(
    query
  )}&time=${now}`;
}

export async function getMetric(releaseName) {
  const req = await request({
    method: "GET",
    json: true,
    uri: buildURI(`
      rate(airflow_scheduler_heartbeat{deployment=~"${releaseName}", type="counter"}[1m])
    `)
  }).catch(err => log.debug(err));
  return { result: req.data ? req.data.result : [] };
}

// Start the subscription
export async function subscribe(parent, args, { pubsub }) {
  let { releaseName } = args;

  // Return sample data
  if (useSample) {
    return createPoller(publish => {
      publish({ deploymentStatus: { result: samplePromise } });
    }, pubsub);
  }

  // Return promQL data if in production
  return createPoller(async publish => {
    const res = await Promise.resolve(getMetric(releaseName));
    publish({
      deploymentStatus: {
        result:
          res && res.result && res.result.length ? res.result[0].value[1] : 0
      }
    });
  }, pubsub);
}

export default { subscribe };
