import config from "config";
import { snakeCase, trim } from "lodash";

/*
 * Attempt to parse a value as JSON, and either return
 * the parsed JSON object/array, or the primitive if fails.
 * @param {Whatever} thing Thing of any type.
 * @return {JSON/Whatever} Either the valid JSON if it parses
 * successfully, otherwise the originally passed in value.
 */
export function parseJSON(thing) {
  try {
    return JSON.parse(thing);
  } catch {
    return thing;
  }
}

/*
 * Utility function to get the generated cookie name
 * for this cluster.
 * @return {String} The cookie name.
 */
export function getCookieName() {
  const baseDomain = config.get("helm.baseDomain");
  return `astronomer_${snakeCase(baseDomain)}_auth`;
}

/*
 * Return the API version.
 * @return {String} The API version.
 */
export function version() {
  return trim(config.get("webserver.endpoint"), "/");
}

/*
 * Return the URL scheme.
 * @return {String} The URL scheme.
 */
export function scheme() {
  return process.env.NODE_ENV === "production" ? "https" : "http";
}

/*
 * Return full UI scheme/host.
 * @return {String} The UI url.
 */
export function ui() {
  const isProd = process.env.NODE_ENV === "production";
  const baseDomain = config.get("helm.baseDomain");
  const { subdomain, port } = config.get("ui");
  const url = `${scheme()}://${subdomain}.${baseDomain}`;
  return isProd ? url : `${url}:${port}`;
}

/*
 * Return deployment subdomain
 * @return {String} The deployment subdomain.
 */
export function deploymentsSubdomain() {
  const baseDomain = config.get("helm.baseDomain");
  const { subdomain } = config.get("deployments.subdomain");
  return `${subdomain}.${baseDomain}`;
}

/*
 * Return flower subdomain
 * @return {String} The flower subdomain.
 */
export function flowerSubdomain() {
  const baseDomain = config.get("helm.baseDomain");
  const releaseName = config.get("helm.releaseName");
  return `${releaseName}-flower.${baseDomain}`;
}

/*
 * Return airflow subdomain
 * @return {String} The airflow subdomain.
 */
export function airflowSubdomain() {
  const baseDomain = config.get("helm.baseDomain");
  const releaseName = config.get("helm.releaseName");
  return `${releaseName}-airflow.${baseDomain}`;
}

/*
 * Return full deployment scheme/host.
 * @return {String} The deployment url.
 */
export function deploymentsUrl() {
  const isProd = process.env.NODE_ENV === "production";
  const subdomain = deploymentsSubdomain();
  const url = `${scheme()}://${subdomain}`;
  return isProd ? url : `${url}`;
}

/*
 * Return full houston scheme/host.
 * @return {String} The houston url.
 */
export function houston() {
  const isProd = process.env.NODE_ENV === "production";
  const baseDomain = config.get("helm.baseDomain");
  const port = config.get("webserver.port");
  const subdomain = config.get("subdomain");
  const url = `${scheme()}://${subdomain}.${baseDomain}`;
  return isProd ? url : `${url}:${port}`;
}
