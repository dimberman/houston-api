import { queryFragment, responseFragment } from "./fragments";
import { track } from "analytics";
import validate from "deployments/validate";
import {
  arrayOfKeyValueToObject,
  generateHelmValues,
  mapPropertiesToDeployment,
  mapCustomEnvironmentVariables
} from "deployments/config";
import {
  generateEnvironmentSecretName,
  generateNamespace
} from "deployments/naming";
import { TrialError } from "errors";
import config from "config";
import { addFragmentToInfo } from "graphql-binding";
import { get, merge, pick } from "lodash";
import { DEPLOYMENT_AIRFLOW } from "constants";

/*
 * Update a deployment.
 * @param {Object} parent The result of the parent resolver.
 * @param {Object} args The graphql arguments.
 * @param {Object} ctx The graphql context.
 * @return {Deployment} The updated Deployment.
 */
export default async function updateDeployment(parent, args, ctx, info) {
  // Get the deployment first.
  const deployment = await ctx.db.query.deployment(
    { where: { id: args.deploymentUuid } },
    queryFragment
  );

  // Block config changes if the user is in a trial
  const stripeEnabled = config.get("stripe.enabled");
  if (!deployment.workspace.stripeCustomerId && stripeEnabled) {
    throw new TrialError();
  }

  // This should be directly defined in the schema, rather than nested
  // under payload as JSON. This is only here until we can migrate the
  // schema of this mutation. The UI should also not send non-updatable
  // properties up in the payload.
  // Until we fix these, pick out the args we allow updating on.
  const updatablePayload = pick(args.payload, [
    "label",
    "description",
    "version"
  ]);

  // Munge the args together to resemble the createDeployment mutation.
  // Once we fix the updateDeployment schema to match, we can skip this.
  const mungedArgs = merge({}, updatablePayload, {
    config: args.config,
    env: args.env,
    properties: get(args, "payload.properties", {})
  });

  console.log(mungedArgs);

  // Validate our args.
  await validate(deployment.workspace.id, mungedArgs, deployment);

  // Create the update statement.
  const where = { id: args.deploymentUuid };
  const data = merge({}, updatablePayload, {
    config: mungedArgs.config,
    ...mapPropertiesToDeployment(mungedArgs.properties)
  });

  // Update the deployment in the database.
  const updatedDeployment = await ctx.db.mutation.updateDeployment(
    { where, data },
    addFragmentToInfo(info, responseFragment)
  );

  // If we're syncing to kubernetes, fire updates to commander.
  if (args.sync) {
    // Set any environment variables.
    await ctx.commander.request("setSecret", {
      releaseName: updatedDeployment.releaseName,
      namespace: generateNamespace(updatedDeployment.releaseName),
      secret: {
        name: generateEnvironmentSecretName(updatedDeployment.releaseName),
        data: arrayOfKeyValueToObject(args.env)
      }
    });

    // Map the user input env vars to a format that the helm chart expects.
    const envs = mapCustomEnvironmentVariables(updatedDeployment, args.env);

    // Update the deployment, passing in our custom env vars.
    await ctx.commander.request("updateDeployment", {
      releaseName: updatedDeployment.releaseName,
      chart: {
        name: DEPLOYMENT_AIRFLOW,
        version: updatedDeployment.version
      },
      rawConfig: JSON.stringify(generateHelmValues(updatedDeployment, envs))
    });
  }

  // Run the analytics track event
  track(ctx.user.id, "Updated Deployment", {
    deploymentId: args.deploymentUuid,
    config: args.config,
    env: args.env,
    payload: args.payload
  });

  // Return the updated deployment object.
  return updatedDeployment;
}
