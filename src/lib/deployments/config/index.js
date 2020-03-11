import {
  houston,
  ui,
  deploymentsSubdomain,
  airflowSubdomain,
  flowerSubdomain,
  deploymentsUrl
} from "../../utilities";
import { parseJSON } from "utilities";
import log from "logger";
import {
  curry,
  find,
  filter,
  first,
  fromPairs,
  get,
  isNumber,
  last,
  map,
  mapValues,
  maxBy,
  merge,
  set,
  split,
  uniq
} from "lodash";
import config from "config";
import yaml from "yamljs";
import semver from "semver";
import {
  DEPLOYMENT_PROPERTY_EXTRA_AU,
  DEPLOYMENT_PROPERTY_ALERT_EMAILS,
  DEPLOYMENT_PROPERTY_COMPONENT_VERSION,
  AIRFLOW_EXECUTOR_LOCAL,
  AIRFLOW_EXECUTOR_KUBERNETES,
  AIRFLOW_EXECUTOR_DEFAULT,
  AIRFLOW_COMPONENT_SCHEDULER,
  AIRFLOW_COMPONENT_WORKERS,
  AIRFLOW_COMPONENT_PGBOUNCER
} from "constants";

/*
 * Generate the full helm configuration for a deployment.
 * @param {Object} deployment The deployment for this configuration.
 * @return {Object} The final helm values.
 */
export function generateHelmValues(deployment, values = {}) {
  const base = config.get("deployments.helm") || {};
  const logValues = config.get("deployments.logHelmValues");

  const helmValues = merge(
    {}, // Start with an empty object.
    base, // Apply base settings from config YAML.
    values, // Apply any settings passed in directly.
    ingress(), // Apply ingress settings.
    defaultResources(), // Apply resource requests and limits.
    limitRange(), // Apply the limit range.
    constraints(deployment), // Apply any constraints (quotas, pgbouncer, etc).
    registry(deployment), // Apply the registry connection details.
    elasticsearch(deployment), // Apply the elasticsearch connection details.
    defaultAirflowTag(deployment), // Apply the default airflow tag we want to deploy.
    platform(deployment), // Apply astronomer platform specific values.
    deploymentOverrides(deployment) // The deployment level config.
  );

  // Log out the YAML values if enabled.
  logValues &&
    log.info(`Final helm values: \n${yaml.stringify(helmValues, 4)}`);

  return helmValues;
}

/*
 * Return the Ingress configuration.
 * @return {Object} Ingress values.
 */
export function ingress() {
  const { baseDomain, releaseName } = config.get("helm");

  const ingressClass = `${releaseName}-nginx`;

  return {
    ingress: {
      baseDomain,
      webserverAnnotations: {
        "kubernetes.io/ingress.class": ingressClass,
        "nginx.ingress.kubernetes.io/custom-http-errors": "403,404,502,503",
        "nginx.ingress.kubernetes.io/auth-url": `${houston()}/v1/authorization`,
        "nginx.ingress.kubernetes.io/auth-signin": `${ui()}/login`,
        "nginx.ingress.kubernetes.io/auth-response-headers": "authorization, username, email",
        "nginx.ingress.kubernetes.io/proxy-cookie-path": `/ /${releaseName}/`,
        "nginx.ingress.kubernetes.io/server-snippet": `|
          location ^~ /api/ {
            if ($host = '${deploymentsSubdomain()}' ) {
              return 404;
            }
            proxy_pass ${deploymentsUrl()}/airflow/$request_uri" 
          }`,
        "nginx.ingress.kubernetes.io/configuration-snippet": `|
          if ($host = '${airflowSubdomain()}' ) {
            return 308 ${deploymentsUrl()}/airflow/$request_uri" 
          }`
      },
      flowerAnnotations: {
        "kubernetes.io/ingress.class": ingressClass,
        "nginx.ingress.kubernetes.io/custom-http-errors": "403,404,502,503",
        "nginx.ingress.kubernetes.io/auth-url": `https://houston.${baseDomain}/v1/authorization`,
        "nginx.ingress.kubernetes.io/auth-signin": `https://app.${baseDomain}//login`,
        "nginx.ingress.kubernetes.io/rewrite-target": "/$2;",
        "nginx.ingress.kubernetes.io/auth-response-headers":
          "authorization, username, email",
        "nginx.ingress.kubernetes.io/proxy-cookie-path": `/ /${releaseName}/`,
        "nginx.ingress.kubernetes.io/configuration-snippet": `|
            if ($host = '${flowerSubdomain()}' ) {
              rewrite ^ ${deploymentsUrl()}/flower" permanent;
            }
          subs_filter_types text/css text/xml text/css;
          sub_filter '="/' '="/${releaseName}/flower/';
          sub_filter_last_modified on;
          sub_filter_once off;`
      }
    }
  };
}

/*
 * Return the LimitRange configuration.
 * @return {Object} LimitRange values.
 */
export function limitRange() {
  if (config.get("helm.singleNamespace")) {
    // If the platform and airflow are deployed in the same namespace we can't
    // usefully enforce any quotas.
    return {};
  }

  const { astroUnit, maxPodAu } = config.get("deployments");
  const max = auToResources(astroUnit, maxPodAu);
  const min = auToResources(astroUnit, 1);

  const podLimit = {
    type: "Pod",
    max
  };

  const containerLimit = {
    type: "Container",
    default: min,
    defaultRequest: min
  };

  return { limits: [podLimit, containerLimit] };
}

/*
 * Return the resource quotas, pgbouncer limits, and other settings
 * based on the totals calculated from this deployment.
 * @param {Object} deployment Deployment
 * @return {Object} Quotas, etc.
 */
export function constraints(deployment) {
  if (config.get("helm.singleNamespace")) {
    // If the platform and airflow are deployed in the same namespace we can't
    // usefully enforce any quotas.
    return {};
  }

  // Get some config settings.
  const {
    astroUnit,
    components,
    executors,
    sidecars: staticSidecarUnit
  } = config.get("deployments");
  const elasticsearchEnabled = config.get("elasticsearch.enabled");

  // Get the executor on this deployment.
  const executor = get(deployment, "config.executor", AIRFLOW_EXECUTOR_DEFAULT);

  // Get the configuration for that executor.
  const executorConfig = find(executors, ["name", executor]);

  // Calculate the total resources required.
  const total = executorConfig.components.reduce(
    (acc, cur) => {
      // Get the component configuration from static config.
      const component = find(components, ["name", cur]) || {};
      const defaults = auToResources(astroUnit, component.au.default);

      // Get cpu and memory for this component out of deployment config,
      // falling back to static config vaules.
      const { cpu, memory } = get(
        deployment,
        `config.${cur}.resources.limits`,
        defaults
      );

      // Check if deployment config has replicas.
      const replicas = get(deployment, `config.${cur}.replicas`, 1);

      // Return combined.
      return {
        cpu: acc.cpu + parseInt(cpu) * replicas,
        memory: acc.memory + parseInt(memory) * replicas,
        pods: acc.pods + replicas
      };
    },
    { cpu: 0, memory: 0, pods: 0 }
  );

  const sidecars = executorConfig.components.reduce(
    (acc, cur) => {
      // How many replicas of this component.
      const replicas = get(deployment, `${cur}.replicas`, 1);

      // Get default sidecar resources to add, and just go ahead and
      // add it to the accumulator.
      const defaultSidecarResources = auToResources(
        staticSidecarUnit,
        replicas,
        false
      );
      acc.cpu += defaultSidecarResources.cpu;
      acc.memory += defaultSidecarResources.memory;

      if (
        executor === AIRFLOW_EXECUTOR_LOCAL &&
        cur === AIRFLOW_COMPONENT_SCHEDULER
      ) {
        // LocalExecutor could possibly have a log server.
        const n = elasticsearchEnabled ? 0 : 1;
        return {
          cpu: acc.cpu + parseInt(astroUnit.cpu) * n,
          memory: acc.memory + parseInt(astroUnit.memory) * n
        };
      } else if (cur === AIRFLOW_COMPONENT_WORKERS && !elasticsearchEnabled) {
        // Workers have a log trimming sidecar.
        return {
          cpu: acc.cpu + parseInt(astroUnit.cpu) * replicas,
          memory: acc.memory + parseInt(astroUnit.memory) * replicas
        };
      } else if (cur === AIRFLOW_COMPONENT_PGBOUNCER) {
        // Pgbouncer has a sidecar metrics exporter.
        return {
          cpu: acc.cpu + parseInt(astroUnit.cpu),
          memory: acc.memory + parseInt(astroUnit.memory)
        };
      }
      return acc;
    },
    // Start off with 1 sidecar for scheduler log trimmer, no matter what.
    { cpu: parseInt(astroUnit.cpu) * 1, memory: parseInt(astroUnit.memory) * 1 }
  );

  // Grab extra au.
  const extraAu =
    !deployment.extraAu && executor === AIRFLOW_EXECUTOR_KUBERNETES
      ? executorConfig.defaultExtraAu
      : deployment.extraAu || 0;

  // Calculate total extra capacity.
  const extra = {
    cpu: parseInt(astroUnit.cpu) * extraAu,
    memory: parseInt(astroUnit.memory) * extraAu,
    pods: parseInt(astroUnit.pods) * extraAu
  };

  // Calculate toatal Au  using totalCPU / astroUnitCPU.
  const totalAu = (total.cpu + extra.cpu) / parseInt(astroUnit.cpu);

  // Set requests/limits quotas.
  const cpu = `${total.cpu * 2 + sidecars.cpu * 2 + extra.cpu}m`;
  const memory = `${total.memory * 2 + sidecars.memory * 2 + extra.memory}Mi`;

  const res = {
    quotas: {
      pods: total.pods * 2 + extra.pods,
      "requests.cpu": cpu,
      "requests.memory": memory,
      "limits.cpu": cpu,
      "limits.memory": memory
    }
  };

  // Set pgbouncer variables.
  set(
    res,
    "pgbouncer.metadataPoolSize",
    Math.floor(astroUnit.actualConns * totalAu)
  );
  set(
    res,
    "pgbouncer.maxClientConn",
    Math.floor(astroUnit.airflowConns * totalAu)
  );

  // Return the final object.
  return res;
}

/*
 * Return the resource defaults for each component.
 * @param {String} type Resource type.
 * @param {String} includeUnits If true include millicpu and memory units.
 * @return {Object} The resource values.
 */
export function defaultResources(type = "default", includeUnits = true) {
  const astroUnit = config.get("deployments.astroUnit");
  const components = config.get("deployments.components");
  const mapper = curry(mapResources)(astroUnit, type, includeUnits);
  return merge(...components.map(mapper));
}

/*
 * Return connection information for the docker registry.
 * Each deployment has a unique password that is auto-generated and
 * lives in a kubernetes secret. This function maps those values into
 * the helm configuration.
 * @param {Object} deployment A deployment object.
 * @return {Object} The registry settings.
 */
export function registry(deployment) {
  const { baseDomain } = config.get("helm");

  return {
    registry: {
      connection: {
        user: deployment.releaseName,
        host: `registry.${baseDomain}`,
        email: `admin@${baseDomain}`
      }
    }
  };
}

/*
 * Return connection information for the elasticsearch connection.
 * @param {Object} deployment A deployment object.
 * @return {Object} The elasticsearch settings.
 */
export function elasticsearch(deployment) {
  const { enabled, connection } = config.get("deployments.elasticsearch");

  // Otherwise return the full elasticsearch configuration.
  return {
    elasticsearch: {
      enabled,
      connection: merge({ user: deployment.releaseName }, connection)
    },
    // This disables StatefulSet workers and uses a Deployment instead.
    // By default we use the Elasticsearch log plugin. This means we print
    // the logs to stdout, which get shipped to Elasticsearch via Fluentd.
    workers: {
      persistence: {
        enabled: !enabled
      }
    }
  };
}

/* Return the platform specific settings.
 * @param {Object} deployment A deployment object.
 * @return {Object} Helm values.
 */
export function platform(deployment) {
  const { releaseName: platformReleaseName } = config.get("helm");

  // Labels to apply to all objects created.
  const labels = {
    platform: platformReleaseName,
    workspace: deployment.workspace.id
  };

  // Pre-0.11.0 format.
  const platform = {
    release: platformReleaseName,
    workspace: deployment.workspace.id
  };

  // Merge both in.
  return { labels, platform };
}

/* Return the default airflow tag to push to deployments.
 * @param {Object} deployment A deployment object.
 * @return {Object} Helm values.
 */
export function defaultAirflowTag({ airflowVersion }) {
  const versionedTag = (airflowImageForVersion(airflowVersion) || {}).tag;
  const defaultAirflowTag = versionedTag
    ? versionedTag
    : defaultAirflowImage().tag;

  return { defaultAirflowTag };
}

/*
 * HOF to help create mergeable resources
 * @param {Object} Astro unit config.
 * @param {String} Default/Limit.
 * @param {String} Component name.
 * @return {Object} Resources for single component.
 */
export function mapResources(au, auType, includeUnits, comp) {
  const limits = auToResources(au, comp.au[auType], includeUnits);
  const requests = comp.au.request
    ? auToResources(au, comp.au.request, includeUnits)
    : limits;

  const resources = {
    requests,
    limits
  };

  const extras = comp.extra
    ? comp.extra.map(extra => {
        return {
          [extra.name]: extra[auType]
        };
      })
    : [];

  const merged = merge({ resources }, ...extras);

  return { [comp.name]: merged };
}

/*
 * Convert an AU size to equivalent resources object.
 * @param {Object} au Astro unit definition.
 * @param {Integer} size Amount of astro units.
 * @return {Object} The resources object.
 */
export function auToResources(au, size, includeUnits = true) {
  const cpu = Math.ceil(au.cpu * size);
  const memory = Math.ceil(au.memory * size);
  if (includeUnits) {
    return { cpu: `${cpu}m`, memory: `${memory}Mi` };
  }
  return { cpu, memory };
}

/*
 * Transform an array of key/value pairs to an object.
 * @param {[]Object} An array of objects with key/value pairs.
 * @return {Object} The object with key/value pairs.
 */
export function arrayOfKeyValueToObject(arr = []) {
  return fromPairs(arr.map(i => [i.key, i.value]));
}

/*
 * Transform an object of key/value pairs to an array.
 * @param {Object} An array of objects with key/value pairs.
 * @return {[]Object} The object with key/value pairs.
 */
export function objectToArrayOfKeyValue(obj = {}) {
  return map(obj, (value, key) => ({ key, value }));
}

/*
 * Map legacy DeploymentProperties to their new top-level names.
 * This is purely to bridge the gap from the legacy API.
 * @param {Object} An object with key/value pairs.
 * @return {[]Object} The object with key/value pairs.
 */
export function mapPropertiesToDeployment(obj = {}) {
  const mapped = {
    extraAu: get(obj, DEPLOYMENT_PROPERTY_EXTRA_AU, 0)
  };

  // Only set this if we have a value.
  const airflowVersion = get(obj, DEPLOYMENT_PROPERTY_COMPONENT_VERSION);
  if (airflowVersion) mapped.airflowVersion = airflowVersion;

  if (obj[DEPLOYMENT_PROPERTY_ALERT_EMAILS]) {
    mapped.alertEmails = {
      set: parseJSON(obj[DEPLOYMENT_PROPERTY_ALERT_EMAILS])
    };
  }

  return mapped;
}

/*
 * Map top level deployment fields to legacy properties.
 * This is purely to bridge the gap from the legacy API.
 * @param {Object} An object
 * @return {[]Object} The object with key/value pairs.
 */
export function mapDeploymentToProperties(dep = {}) {
  const mapped = {};

  if (dep.extraAu) {
    mapped[DEPLOYMENT_PROPERTY_EXTRA_AU] = dep.extraAu;
  }

  if (dep.airflowVersion) {
    mapped[DEPLOYMENT_PROPERTY_COMPONENT_VERSION] = dep.airflowVersion;
  }

  if (dep.alertEmails) {
    mapped[DEPLOYMENT_PROPERTY_ALERT_EMAILS] = dep.alertEmails;
  }

  return mapped;
}

/*
 * Find the most recent tag in a list of image tags.
 */
export function findLatestTag(tags = []) {
  const prefix = config.get("deployments.tagPrefix");
  const filtered = tags.filter(t => t.startsWith(`${prefix}-`));
  return maxBy(filtered, t => parseInt(last(split(t, "-"))));
}

/*
 * Generate the next tag name for a deployment image.
 */
export function generateNextTag(latest) {
  if (!latest) return generateDefaultTag();
  const prefix = config.get("deployments.tagPrefix");
  const num = parseInt(last(split(latest, "-")));
  return `${prefix}-${num + 1}`;
}

/*
 * Generate the default tag for an airflow deployment.
 */
export function generateDefaultTag() {
  const prefix = config.get("deployments.tagPrefix");
  return `${prefix}-1`;
}

/*
 * Generate the default `config` for a new deployment, if nothing
 * is passed to the mutation.
 * @return {Object} The default config.
 */
export function generateDefaultDeploymentConfig() {
  return { executor: AIRFLOW_EXECUTOR_DEFAULT };
}

/*
 * Generate the deployment specific overrides.
 * Specfically, this currently maps numeric resources
 * values that are sent by the UI to be valid for helm.
 * @param {Object} deployment A deployment object.
 * @return {Object} Properly formatted config, pulled from deployment.
 */
export function deploymentOverrides(deployment) {
  // Get the deployment config.
  const cfg = get(deployment, "config", {});

  // Map over all keys on deployment config, looking for components that have
  // resources defined.
  return mapValues(cfg, val1 => {
    if (val1.resources) {
      // Create a modified component, possibly altering resources.
      const component = {
        ...val1,
        resources: mapValues(val1.resources, val2 => {
          return mapValues(val2, (val3, key3) => {
            // Wrap numeric values with units.
            if (key3 === "cpu" && isNumber(val3)) return `${val3}m`;
            if (key3 === "memory" && isNumber(val3)) return `${val3}Mi`;
            return val3;
          });
        })
      };

      // Currently, the UI sends up limits, which are stored on the deployment
      // config. When we merge these in, we need to ensure that requests and limits match.
      // Typically the first condition here will be hit. Else condition provided as fallback.
      if (component.resources.limits) {
        component.resources.requests = component.resources.limits;
      } else if (component.resources.requests) {
        component.resources.limits = component.resources.requests;
      }

      // Return the new component.
      return component;
    }

    // If no resources defined, just return the object as is.
    return val1;
  });
}

/*
 * Transform an array of environment variables to a format
 * that the airflow helm chart expects. The values themselves are
 * stored in a kubernetes secret. This maps user input to helm values.
 * @param {Object} deployment The deployment these variables belong to.
 * @param {[]Object} envs The list of user inputed environment variables.
 * @reuturn {[]Object} The values ready to be passed to helm.
 */
export function mapCustomEnvironmentVariables(deployment, envs = []) {
  const secrets = envs.map(env => {
    return {
      envName: env.key,
      secretName: `${deployment.releaseName.replace(/_/g, "-")}-env`,
      secretKey: env.key
    };
  });

  return { secret: secrets };
}

/*
 * Generate the default airflow image tag.
 * @reuturn {String} Airflow image tag.
 */
export function airflowImageTag(version, distro) {
  return `${version}-${distro}`;
}

/*
 * Get list of supported Airflow images.
 * @reuturn {[String]} List of airflow images.
 */
export function airflowImages() {
  return config
    .get("deployments.images")
    .slice(0)
    .sort((a, b) => semver.rcompare(a.version, b.version));
}

/*
 * Get list of supported Airflow versions.
 * @reuturn {[Object]} List of Airflow versions.
 */
export function airflowVersions() {
  return uniq(map(airflowImages(), "version"));
}

/*
 * Get default Airflow image.
 * @reuturn {String} Default Airflow image.
 */
export function defaultAirflowImage() {
  return first(filter(airflowImages(), i => i.channel === "stable"));
}

/*
 * Get Airflow image for specified version.
 * @reuturn {String} Default Airflow image.
 */
export function airflowImageForVersion(version) {
  return first(
    filter(
      airflowImages(),
      i => i.channel === "stable" && i.version === version
    )
  );
}
