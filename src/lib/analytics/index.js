import { prisma } from "generated/client";
import config from "config";
const Analytics = require("analytics-node");

// Get the analytics settings
const { writeKey } = config.get("analytics");

// Create the analytics-node client
const client = writeKey ? new Analytics(writeKey) : null;

// Form the identify function. userId should be passed as a string and
// traits should be passed as an object of key/value pairs.
export function identify(userId, traits) {
  if (client) {
    client.identify({ userId, traits });
  }
}

export function track(userId, event, properties) {
  if (client) {
    const email = usersQuery(userId);
    properties.email = email;
    client.track({ userId, event, properties });
  }
}

export function group(userId, groupId, traits) {
  if (client) {
    client.group({ userId, groupId, traits });
  }
}

export async function usersQuery(id) {
  const email = await prisma.user({ id }).email;
  return email;
}
