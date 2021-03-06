import fragment from "./fragment";
import { UserInviteExistsError } from "errors";
import { ui } from "utilities";
import { group } from "analytics";
import { sendEmail } from "emails";
import { UserInputError } from "apollo-server";
import shortid from "shortid";
import { addFragmentToInfo } from "graphql-binding";
import { ENTITY_WORKSPACE, INVITE_SOURCE_WORKSPACE } from "constants";

/*
 * Add a user to a workspace.
 * @param {Object} parent The result of the parent resolver.
 * @param {Object} args The graphql arguments.
 * @param {Object} ctx The graphql context.
 * @return {User} The updated Workspace.
 */
export default async function workspaceAddUser(parent, args, ctx, info) {
  // Pull out some args.
  const { email, workspaceUuid } = args;
  let { role } = args;

  // Check for user by incoming email arg.
  const emailRow = await ctx.db.query.email(
    { where: { address: email.toLowerCase() } },
    `{ user { id } }`
  );

  if (!role.startsWith(`${ENTITY_WORKSPACE}_`))
    throw new UserInputError("invalid workspace role");

  const user = emailRow ? emailRow.user : null;

  // If we already have a user, create the role binding to the workspace.
  if (user) {
    await ctx.db.mutation.createRoleBinding({
      data: {
        role,
        user: { connect: { id: user.id } },
        workspace: { connect: { id: workspaceUuid } }
      }
    });

    // Run the group event to bucket user into workspace
    group(user.id, workspaceUuid, null);
  } else {
    // Check if we have an invite for incoming email and user.
    const existingInvites = await ctx.db.query.inviteTokensConnection(
      {
        where: {
          email: email.toLowerCase(),
          workspace: { id: workspaceUuid }
        }
      },
      `{ aggregate { count } }`
    );
    if (existingInvites.aggregate.count > 0) throw new UserInviteExistsError();

    const token = shortid.generate();
    // Create the invite token if we didn't already have one.
    // Multi-column unique fields would be nice, but not supported yet
    // https://github.com/prisma/prisma/issues/3405
    const res = await ctx.db.mutation.createInviteToken(
      {
        data: {
          email: email.toLowerCase(),
          token,
          role,
          workspace: { connect: { id: workspaceUuid } },
          source: INVITE_SOURCE_WORKSPACE
        }
      },
      `{ id, workspace { label } }`
    );

    sendEmail(email, "user-invite", {
      strict: true,
      UIUrl: ui(),
      token,
      workspaceLabel: res.workspace.label
    });
    // Run the group event to bucket user into workspace
    // Note, we can use the inviteId here because it will be the same as the
    // userId once the user accepts the invite
    group(res.id, workspaceUuid, null);
  }

  // Return the workspace.
  return ctx.db.query.workspace(
    { where: { id: workspaceUuid } },
    addFragmentToInfo(info, fragment)
  );
}
