import fragment from "./fragment";
import { createUser as _createUser, isFirst } from "users";
import { getClient } from "oauth/config";
import { track } from "analytics";
import { PublicSignupsDisabledError } from "errors";
import { ui } from "utilities";
import { prisma } from "generated/client";
import { createAuthJWT, setJWTCookie } from "jwt";
import { ApolloError } from "apollo-server";
import config from "config";
import { first, merge } from "lodash";
import { URLSearchParams } from "url";

/*
 * Handle oauth request.
 * @param {Object} req The request.
 * @param {Object} res The response.
 */
export default async function(req, res, next) {
  // Grab params out of the request body.
  const { state: rawState } = req.body;
  const firstUser = await isFirst();
  const publicSignups = config.get("publicSignups");

  // TODO: Handle `error` in the response

  // Parse the state object.
  const state = JSON.parse(decodeURIComponent(rawState));

  // Get the provider module.
  const provider = await getClient(state.provider);

  const tokenSet = await provider.authorizationCallback(null, req.body, {
    state: rawState,
    // Don't validate the nonce. Not great, but we don't store the nonce in a
    // session right now, so we can't validate this
    nonce: null
  });

  const email = tokenSet.claims.email
    ? tokenSet.claims.email.toLowerCase()
    : tokenSet.claims.preferred_username
    ? tokenSet.claims.preferred_username.toLowerCase()
    : null;

  // Grab user data
  // Some IDPs don't return useful info, so fall back to the claims if we don't have it
  const userData = merge(await provider.userinfo(tokenSet.access_token), {
    email,
    sub: tokenSet.claims.sub,
    name: tokenSet.claims.name || tokenSet.claims.unique_name
  });

  const { sub: providerUserId, name: fullName, picture: avatarUrl } = userData;

  if (!email) {
    // Somehow we got no email! Abort
    return next("No email from userinfo!");
  }

  // Search for user in our system using email address.
  const user = first(
    await prisma
      .users({ where: { emails_some: { address: email } } })
      .$fragment(fragment)
  );

  let userId = null;

  try {
    // Set the userId, either the existing, or the newly created one.
    userId = user
      ? user.id
      : await _createUser({
          fullName,
          email,
          inviteToken: state.inviteToken,
          active: true // OAuth users are active immediately
        });
  } catch (e) {
    // Confirm that error is a noPubSignupsError and send user back to UI login
    // where an error message can be shown
    if (e instanceof ApolloError) {
      const url = `${ui()}/login?error=${e.extensions.code}`;
      res.redirect(url);
    }
  }

  // If we already have a user, update it.
  if (user) {
    await prisma.updateUser({
      where: { id: userId },
      data: { fullName, avatarUrl }
    });

    // Run the analytics track call for a log in event
    track(user.id, "Logged In", {
      email: userData.email,
      name: userData.name,
      method: "OAuth"
    });
  }

  // If the user does not exist and public signups are disabled, throw an error
  if (!user && !publicSignups && !firstUser && !state.inviteToken) {
    throw new PublicSignupsDisabledError();
  }

  // If we just created the user, also create and connect the oauth cred.
  if (!user) {
    await prisma.createOAuthCredential({
      oauthProvider: state.provider,
      oauthUserId: providerUserId,
      user: { connect: { id: userId } }
    });
  }

  // Create the JWT.
  const { token } = createAuthJWT(userId);

  // Set the cookie.
  setJWTCookie(res, token);

  // Add userId and email for in-app tracking
  state.extras = { ...state.extras, userId, email };

  // Build redirect query string.
  const qs = new URLSearchParams([
    ["extras", JSON.stringify(state.extras)],
    ["strategy", state.provider],
    ["token", token]
  ]);

  // Respond with redirect to the UI.
  const url = `${ui()}/${state.redirect || "oauth"}?${qs}`;
  const cleanUrl = url.replace(/([^:]\/)\/+/g, "$1");
  res.redirect(cleanUrl);
}
