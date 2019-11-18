import log from "logger";
import { createDockerJWT } from "registry/jwt";
import { prisma } from "generated/client";
import { extractImageMetadata } from "routes/v1/registry/events/post";
import request from "request-promise-native";
import config from "config";
import { DEPLOYMENT_AIRFLOW } from "constants";
import { execSync } from "child_process";

export async function up() {
  // Since we are using the prisma client library and we run `prisma generate`
  // before these migrations, the query below will fail, looking for new columns against
  // an unmigrated database.
  log.debug("Running prisma-deploy");
  execSync("node_modules/.bin/prisma deploy --force", { stdio: "inherit" });

  // Query for all deployments in the system.
  const deployments = await prisma.deployments({}, `{ releaseName }`);

  // Grab some configuration.
  const {
    releaseNamespace: namespace,
    releaseName: platformReleaseName
  } = config.get("helm");

  const registryPort = config.get("registry.port");

  // Current deployment as we loop through them.
  if (!deployments) {
    log.info("There is no deployments :(");
    return;
  }

  // Skip for local env without docker registry
  try {
    for (const deployment of deployments) {
      log.debug(`Migrating ${deployment.releaseName}...`);
      const releaseName = deployment.releaseName;
      const repo = `${releaseName}/${DEPLOYMENT_AIRFLOW}`;
      const registry = `${platformReleaseName}-registry.${namespace}:${registryPort}`;

      // Create a JWT for the registry request.
      const dockerJWT = await createDockerJWT("houston", [
        {
          type: "repository",
          // Build the repo name.
          name: repo,
          actions: ["pull"]
        }
      ]);

      // Build the registry request URL.
      const uri = `http://${registry}/v2/${repo}/tags/list`;
      log.debug(`Requesting docker tags for ${releaseName} at ${uri}`);

      const { tags } = await request({
        method: "GET",
        uri,
        json: true,
        headers: { Authorization: `Bearer ${dockerJWT}` }
      });

      if (!tags) {
        log.info("There is no tags :(");
        continue;
      }

      for (const tag of tags) {
        // For each tag create record
        const ev = {
          target: {
            url: `http://${registry}/v2/${repo}/manifests/${tag}`,
            repository: repo,
            mediaType: "application/vnd.docker.distribution.manifest.v2+json"
          }
        };
        const imageMetadata = await extractImageMetadata(ev);
        try {
          await prisma.createDockerImage({
            name: `${repo}:${tag}`,
            deployment: {
              connect: { releaseName }
            },
            labels: imageMetadata.labels,
            env: imageMetadata.env,
            tag: tag,
            digest: imageMetadata.digest
          });
        } catch (error) {
          log.error(`Error during create docker image: ${error}`);
        }
      }
    }
  } catch (e) {
    log.error(e);
  }
}

export async function down() {}
