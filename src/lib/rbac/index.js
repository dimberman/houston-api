import userFragment from "./user-fragment";
import serviceAccountFragment from "./service-account-fragment";
import { decodeJWT } from "jwt";
import { PermissionError } from "errors";
import { prisma } from "generated/client";
import { filter, find, flatten, includes, map, size } from "lodash";
import config from "config";
import {
  ENTITY_DEPLOYMENT,
  ENTITY_WORKSPACE,
  DEPLOYMENT_ADMIN,
  DEPLOYMENT_EDITOR,
  WORKSPACE_ADMIN,
  WORKSPACE_EDITOR
} from "constants";

// Mapping of entityTypes to role.
export const serviceAccountRoleMappings = {
  [ENTITY_DEPLOYMENT]: DEPLOYMENT_EDITOR,
  [ENTITY_WORKSPACE]: WORKSPACE_EDITOR
};

/*
 * Check if the user has the given permission for the entity.
 * @param {Object} user The current user.
 * @param {String} permission The required permission.
 */
export function hasPermission(user, permission, entityType, entityId) {
  // If user is falsy, immediately fail.
  if (!user) return false;

  // Check if we're looking for a global permission.
  const systemPermission = permission.startsWith("system");

  // If we're looking for a system permission, return if user has it.
  if (systemPermission) return hasSystemPermission(user, permission);

  // If we don't have both of these, return false from here.
  if (!entityType || !entityId) return false;

  // Otherwise we have to ensure the user has access to the entity.
  const binding = find(user.roleBindings, binding => {
    // Return true if we're looking for a scoped permission,
    // and this binding has the entity type we're interested
    // in and the id matches.
    const hasEntity = !!binding[entityType];
    return hasEntity && binding[entityType].id === entityId;
  });

  // If we didn't find a roleBinding, return false.
  if (!binding) return false;

  // Otherwise return if this role has an appropriate permission.
  const role = find(config.get("roles"), { id: binding.role });
  return includes(role.permissions, permission);
}

/*
 * Check if the user has a system permission.
 * @param {Object} user The current user.
 * @param {String} user The desired permission.
 * @param {Boolean} If the user has the system permission.
 */
export function hasSystemPermission(user, permission) {
  const permissions = flatten(
    user.roleBindings.map(binding => {
      const role = find(config.get("roles"), { id: binding.role });
      return filter(role.permissions, p => p.startsWith("system"));
    })
  );

  return includes(permissions, permission);
}

/*
 * Check if the user has the given permission for the entity.
 * Throws if the user does not have permission.
 * @param {Object} user The current user.
 * @param {String} permission The required permission.
 */
export function checkPermission(user, permission, entityType, entityId) {
  if (!hasPermission(user, permission, entityType, entityId)) {
    throw new PermissionError();
  }
}

/* Get a user that has the required information to make
 * RBAC decisions.
 * @param {String} id The user id.
 * @return {Promise<Object>} The User object with RoleBindings.
 */
export function getUserWithRoleBindings(id) {
  return prisma.user({ id }).$fragment(userFragment);
}

/* Get a ServiceAccount that has the required information to make
 * RBAC decisions.
 * @param {String} apiKey The apiKey.
 * @return {Object} The ServiceAccount object with RoleBindings.
 */
export async function getServiceAccountWithRoleBindings(apiKey) {
  // Get the Service Account by API Key.
  const serviceAccount = await prisma
    .serviceAccount({ apiKey })
    .$fragment(serviceAccountFragment);

  // Return early if we didn't find a service account.
  if (!serviceAccount) return;

  // Return a slightly modified version, to mimic what we return
  // for a user.
  return {
    id: serviceAccount.id,
    roleBindings: [serviceAccount.roleBinding]
  };
}

/*
 * Check if the authorization header looks like a service account.
 * @param {String} authorization An authorization header.
 * @return {Boolean} If the header looks like a service account
 */
export function isServiceAccount(authorization) {
  return size(authorization) === 32 && !includes(authorization, ".");
}

/*
 * Get either a user or a Service Account from an Authorization header.
 * @param {String} authorization An authorization header.
 * @return {Object} The authed user or Service Account.
 */
export async function getAuthUser(authorization) {
  // Return early if empty.
  if (!authorization) return;

  // Check if the header is a service account.
  const isServiceAcct = isServiceAccount(authorization);

  // If we do have a service account, set it as the user on the context.
  if (isServiceAcct) {
    return await addDeploymentRoleBindings(
      getServiceAccountWithRoleBindings(authorization)
    );
  }

  // Decode the JWT.
  const { uuid } = await decodeJWT(authorization);

  // If we have a userId, set the user on the session,
  // otherwise return nothing.
  if (uuid)
    return await addDeploymentRoleBindings(getUserWithRoleBindings(uuid));
}

/*
 * TODO: Remove me and the two references to me right above when
 * deployment level RBAC is in place.
 * This function wraps the two calls above to append fake roleBindings
 * to the user object for any deployments that belong to workspaces where
 * the user has WORKSPACE_ADMIN role.
 * @param {Promise} promise A proimse for a user or service account.
 * @return {Object} The user object with roleBindings.
 */
async function addDeploymentRoleBindings(promise) {
  // Resolve the promise for user/service account.
  const user = await promise;
  if (!user) return;

  // Get the list of workspace ids where user is admin.
  const workspaceIds = map(
    filter(user.roleBindings, rb => rb.role === WORKSPACE_ADMIN),
    "workspace.id"
  );

  // Get the deployments that are under any of our workspaces.
  const deployments = await prisma
    .deployments({
      where: { workspace: { id_in: workspaceIds } }
    })
    .id();

  // Generate fake rolebindings for deployment level admin.
  const roleBindings = map(deployments, deployment => ({
    role: DEPLOYMENT_ADMIN,
    workspace: null,
    deployment: { id: deployment.id }
  }));

  // Return a modified user, spreading existing rolebindings, with new fake ones.
  return { ...user, roleBindings: [...user.roleBindings, ...roleBindings] };
}

// /* If the passed argument is a string, lookup the user by id.
//  * Otherwise use the user.id to get the user, with RoleBindings.
//  * @param {String|Object} user The user object or id.
//  * @return {Promise<Object} The user object with RoleBindings.
//  */
// export function ensureUserRoleBindings(user) {
//   if (isString(user)) return getUserWithRoleBindings(user);
//   return getUserWithRoleBindings(user.id);
// }
