import { prisma } from "generated/client";

import {
  hasPermission,
  getAuthUser,
  accesibleDeploymentsWithPermission
} from "rbac";
import log from "logger";
import { createDockerJWT } from "registry/jwt";
import validateDeploymentCredentials from "deployments/validate/authorization";
import { ACTIONS, VALID_RELEASE_NAME } from "deployments/validate/docker-tag";
import config from "config";
import { compact, isArray, find, includes } from "lodash";
import { ENTITY_DEPLOYMENT } from "constants";

// List of expected registry codes.
const REGISTRY_CODES = {
  UNKNOWN: "NAME_UNKNOWN",
  UNAUTHORIZED: "UNAUTHORIZED",
  DENIED: "DENIED"
};

/*
 * Handle authorization requests from the docker registry.
 * @param {Object} req The request.
 * @param {Object} res The response.
 */
export default async function(req, res) {
  log.info("Processing registry authorization");

  // If we don't have an original URL, it's a mistake. Can't proceed.
  if (process.env.NODE_ENV === "production") {
    const originalUri = req.get("x-original-uri");
    if (!originalUri) {
      return sendError(
        res,
        REGISTRY_CODES.UNKNOWN,
        "Unknown registry service request"
      );
    }
  }

  // Get the authorization header, fail if not found.
  const authorization = req.get("authorization");

  if (!authorization) {
    return sendError(
      res,
      REGISTRY_CODES.UNAUTHORIZED,
      "No authorization credentials specified",
      401,
      { "WWW-Authenticate": "Bearer" }
    );
  }

  if (!authorization || authorization.substr(0, 5) !== "Basic") {
    return sendError(
      res,
      REGISTRY_CODES.UNAUTHORIZED,
      "No authorization credentials specified"
    );
  }

  // Pull authorization token out of header and parse it into user and password.
  const token = authorization.substr(6);
  const [authUser, authPassword] = Buffer.from(token, "base64")
    .toString()
    .split(":");

  // Determine if this is a user triggered action, or from a running deployment
  // (i.e. the ImagePullSecret passed in to Helm).
  const isDeploymentAuth = await validateDeploymentCredentials(
    authUser,
    authPassword,
    "registryPassword"
  );

  // Look up the requesting User or Service Account.
  const user = await getAuthUser(authPassword);
  const userId = isDeploymentAuth ? "registry" : user ? user.id : null;
  if (!userId) return sendError(res, REGISTRY_CODES.DENIED, "Access denied");

  const baseImages = config.get("jwt.registry.baseImages");

  // JWT response payload.
  const payload = [];

  // Pull out the scope variable.
  const scope = req.query.scope;

  // Scope will not exist on a docker login (astro auth login).
  // It will exist for a code push (docker push) and when deployment pods
  // pull the image (docker pull).
  if (scope) {
    for (let parsed of compact(
      (isArray(scope) ? scope : [scope]).map(parseScope)
    )) {
      const isPushAction = includes(parsed.actions, ACTIONS.PUSH);
      if (includes(baseImages, parsed.name)) {
        // Only sys admins can push to the base images, but anyone can pull from them
        if (isPushAction) {
          const allowed = hasPermission(user, "system.registryBaseImages.push");

          if (!allowed) {
            return sendError(
              res,
              REGISTRY_CODES.DENIED,
              `You do not have permission to manage ${parsed.name}`
            );
          }
        }
      } else {
        const releaseName = releaseNameFromImage(parsed.name);

        if (!releaseName) {
          return sendError(
            res,
            REGISTRY_CODES.UNKNOWN,
            "Unknown scope, cannot determine repository or image"
          );
        }

        // This path is for a code push.
        if (!isDeploymentAuth) {
          // Look up deploymentId by releaseName.
          const deploymentId = await prisma.deployment({ releaseName }).id();

          // Check if the User or Service Account has permission to update this deployment.
          const permission = isPushAction
            ? "deployment.images.push"
            : "deployment.images.pull";
          const allowed = hasPermission(
            user,
            permission,
            ENTITY_DEPLOYMENT.toLowerCase(),
            deploymentId
          );

          if (!allowed) {
            return sendError(
              res,
              REGISTRY_CODES.DENIED,
              `You do not have ${permission} permission on ${releaseName}`
            );
          }
        }
      }

      payload.push(parsed);
    }
  }

  // Add in PULL permission to the base images - this lets us "mount"/share
  // layers from that to speed up pushes
  for (let name of config.get("jwt.registry.baseImages")) {
    if (!find(payload, _ => _.name == name)) {
      payload.push({ type: "repository", actions: [ACTIONS.PULL], name });
    }
  }

  // And add in PULL permissions to all the other deployments this user has
  // access to. This is so that if the user retags an image (i.e. "promote"
  // from staging to production) the image can be already there and the push
  // will be almost instant.
  const otherReleaseIds = accesibleDeploymentsWithPermission(
    user,
    "deployment.images.pull"
  );
  if (otherReleaseIds.length > 0) {
    const otherReleaseNames = await prisma
      .deployments({
        where: {
          id_in: otherReleaseIds
        }
      })
      .releaseName();
    for (let name of otherReleaseNames.map(_ => _.releaseName)) {
      name = `${name}/airflow`;
      if (!find(payload, _ => _.name == name)) {
        payload.push({ type: "repository", actions: [ACTIONS.PULL], name });
      }
    }
  }

  // Create and respond with the JWT.
  const expiration = 3600;
  const dockerJWT = await createDockerJWT(userId, payload, expiration);
  res.json({
    token: dockerJWT,
    expires_in: expiration,
    issued_at: new Date().toISOString()
  });
}

const SCOPE_REGEX = /^(?<type>repository):(?<name>[^:]+):(?<actions>[a-z,]+)$/;

/*
 * Parse a scope query string parameter from the registry.
 * @param {String} scope The user scope.
 * @return {Object} The parsed information.
 */
export function parseScope(scope) {
  const matches = SCOPE_REGEX.exec(scope);
  if (matches) {
    // Comma separate actions
    matches.groups.actions = matches.groups.actions.split(",");
    return matches.groups;
  }
  return {};
}

/*
 * Parse an (and validate) releaseName from image
 * @param {String} scope The user scope.
 */
export function releaseNameFromImage(image) {
  const matches = VALID_RELEASE_NAME.exec(image);
  if (matches) return matches.groups.releaseName;
}

/*
 * Send correctly formatted error response back to registry.
 * @param {Object} res The response
 * @param {String} code The error code
 * @param {String} message The error message
 */
export function sendError(res, code, message, http_err) {
  return res
    .status(http_err || 401)
    .set("Content-Type", "application/json")
    .end(
      JSON.stringify({
        errors: [
          {
            code,
            message,
            details: []
          }
        ]
      })
    );
}
