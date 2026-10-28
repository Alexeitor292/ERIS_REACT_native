export type SingleSignOnInputs = {
  methodsKnown: boolean;
  entraEnabled: boolean;
  localLoginEnabled: boolean;
  signedIn: boolean;
  isInitializing: boolean;
  entraReason: string | null;
  signedOut: boolean;
};

/**
 * Whether the sign-in page should hand straight over to Entra.
 *
 * Only when Entra is the sole method (as the API reports it, not the build
 * default), nobody is signed in, and the person did not just sign out or come
 * back from a failed Entra attempt: those show the page instead, so a refusal
 * or a sign-out can never become a redirect loop.
 */
export function shouldStartSingleSignOn(inputs: SingleSignOnInputs): boolean {
  return (
    inputs.methodsKnown &&
    inputs.entraEnabled &&
    !inputs.localLoginEnabled &&
    !inputs.signedIn &&
    !inputs.isInitializing &&
    !inputs.entraReason &&
    !inputs.signedOut
  );
}
