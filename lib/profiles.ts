/**
 * Profile creation/deletion helpers that enforce ownership: only profiles this
 * checkout created (recorded in .incogniton/created-profiles.json) can be deleted.
 */
import { StarterError, fromSdkError, sanitize } from './errors.js';
import { getProfileStatus, READY, shutdownOwnedProfile, type IncognitonApi } from './incogniton.js';
import { forgetCreatedProfile, isCreatedByStarter, recordCreatedProfile } from './state.js';

/**
 * Creates a profile with the minimal verified payload and records it.
 * Not retried automatically: a timed-out create may still have succeeded.
 */
export async function createRecordedProfile(api: IncognitonApi, options: { name: string; notes?: string; createdBy: string }): Promise<string> {
  let response: { status?: string; profile_browser_id?: string; message?: string };
  try {
    // SDK: client.profile.add({ profileData }) -> POST /profile/add.
    // Only profile_name is required; the app fills in a fingerprint, the newest
    // browser version, the "Unassigned" group and the host OS.
    response = (await api.client.profile.add({
      profileData: {
        general_profile_information: {
          profile_name: options.name,
          profile_notes: options.notes ?? 'Created by incogniton-automation-examples; safe to delete.',
        },
      },
    })) as typeof response;
  } catch (error) {
    throw fromSdkError(error, 'Creating profile', api.port);
  }
  if (response.status !== 'ok' || !response.profile_browser_id) {
    throw new StarterError('api_error', `Profile creation failed: ${sanitize(response.message ?? String(response.status))}`);
  }
  recordCreatedProfile({ profileId: response.profile_browser_id, name: options.name, createdAt: new Date().toISOString(), createdBy: options.createdBy });
  return response.profile_browser_id;
}

export interface DeleteReport {
  profileId: string;
  ok: boolean;
  error?: string;
}

/** Deletes a profile only if this checkout created it. Stops it gracefully first if needed. */
export async function deleteRecordedProfile(api: IncognitonApi, profileId: string, options: { stopTimeoutMs: number }): Promise<DeleteReport> {
  if (!isCreatedByStarter(profileId)) {
    return { profileId, ok: false, error: 'refused: profile is not recorded in .incogniton/created-profiles.json' };
  }
  try {
    let status = await getProfileStatus(api, profileId).catch((error: StarterError) => {
      if (error.kind === 'profile_not_found') return 'deleted';
      throw error;
    });
    if (status === 'deleted') {
      forgetCreatedProfile(profileId);
      return { profileId, ok: true };
    }
    if (status !== READY) {
      // Running or syncing: let it finish / stop it (profile.stop fallback) before deleting.
      const report = await shutdownOwnedProfile(api, profileId, async () => undefined, { stopTimeoutMs: options.stopTimeoutMs, graceMs: 2000 });
      status = report.finalStatus ?? status;
    }
    // SDK: client.profile.delete(id) -> GET /profile/delete/{id}
    const response = (await api.client.profile.delete(profileId)) as { status?: string; message?: string };
    if (response.status !== 'ok') return { profileId, ok: false, error: sanitize(response.message ?? String(response.status)) };
    forgetCreatedProfile(profileId);
    return { profileId, ok: true };
  } catch (error) {
    return { profileId, ok: false, error: sanitize((error as Error).message) };
  }
}
