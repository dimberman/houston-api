import fragment from "./fragment";
import { generateHelmValues } from "deployments/config";
import { generateNamespace } from "deployments/naming";
import { addFragmentToInfo } from "graphql-binding";
import { DEPLOYMENT_AIRFLOW } from "constants";

/*
 * Upgrade a deployment to a newer version.
 * @param {Object} parent The result of the parent resolver.
 * @param {Object} args The graphql arguments.
 * @param {Object} ctx The graphql context.
 * @return {Deployment} The updated Deployment.
 */
export default async function upgradeDeployment(parent, args, ctx, info) {
  // Update the deployment in the database.
  const where = { id: args.deploymentUuid };
  const data = { version: args.version };
  const updatedDeployment = await ctx.db.mutation.updateDeployment(
    { where, data },
    addFragmentToInfo(info, fragment)
  );

  // In the future, as the airflow chart values continue to evolve,
  // we may need to add some additional upgrade logic here, to take
  // the old value format, and transform them to fit the new format.
  // Houston 1 currently has something similar to this.

  // Fire the helm upgrade to commander.
  await ctx.commander.request("updateDeployment", {
    releaseName: updatedDeployment.releaseName,
    chart: {
      name: DEPLOYMENT_AIRFLOW,
      version: updatedDeployment.version
    },
    namespace: generateNamespace(updatedDeployment.releaseName),
    rawConfig: JSON.stringify(generateHelmValues(updatedDeployment))
  });

  // Return the updated deployment object.
  return updatedDeployment;
}
