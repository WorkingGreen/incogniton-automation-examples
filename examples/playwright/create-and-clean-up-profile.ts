// Create a temporary Incogniton profile with the minimal payload, use it, then delete it.
// Only the profile created by this run is deleted. Pass --keep-profile to keep it for inspection.
// Run: npm run example:temp-profile
import { createApi } from '../../lib/incogniton.js';
import { startFixtureServer } from '../../lib/fixture-server.js';
import { openPlaywrightSession } from '../../lib/playwright-session.js';
import { createRecordedProfile, deleteRecordedProfile } from '../../lib/profiles.js';
import { check, runExample } from '../../lib/run.js';

await runExample(
  { id: 'create-and-clean-up-profile', framework: 'playwright', description: 'Create a temporary profile, use it, and delete only that profile.' },
  { 'keep-profile': { type: 'boolean' } },
  async ({ config, flags, artifact, manage, onCleanup, log, signal }) => {
    const api = createApi(config);
    const fixtures = await startFixtureServer(config);
    onCleanup(() => fixtures.close());

    // 1. Create. The ID comes back as `profile_browser_id` and is recorded in
    //    .incogniton/created-profiles.json before anything else can fail.
    const name = `starter-temp-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const profileId = await createRecordedProfile(api, { name, createdBy: 'create-and-clean-up-profile' });
    log(`created profile ${profileId} (${name})`);

    // Registered cleanup runs even if the steps below fail. runExample always closes managed
    // sessions (graceful browser shutdown) before running onCleanup steps, so the profile is
    // stopped before it is deleted.
    onCleanup(async () => {
      if (flags['keep-profile']) {
        log(`keeping profile ${profileId} as requested; delete later with: npm run profiles -- delete-created`);
        return;
      }
      const deletion = await deleteRecordedProfile(api, profileId, { stopTimeoutMs: config.stopTimeoutMs });
      if (!deletion.ok) {
        throw new Error(`LEFTOVER: profile ${profileId} was not deleted (${deletion.error}). Retry with: npm run profiles -- delete-created --yes`);
      }
      log(`deleted profile ${profileId}`);
    });

    // 2. Use it like any other profile.
    const { page, browserVersion } = manage(await openPlaywrightSession(config, { profileId, api, log, signal }));
    await page.goto(fixtures.url('index.html'));
    await page.getByRole('status').filter({ hasText: 'Fixture ready' }).waitFor();
    const userAgent = await page.locator('#user-agent').textContent();
    check(userAgent?.includes('Chrome/'), 'unexpected user agent');
    await page.screenshot({ path: artifact('temporary-profile.png') });

    // 3. Read back the profile the app generated (fingerprint fields filled in by the app).
    // SDK: client.profile.get(id) -> { status, profileData }
    const { profileData } = await api.client.profile.get(profileId);
    const general = profileData.general_profile_information ?? {};
    return {
      summary: `Created ${profileId}, rendered the fixture in ${browserVersion}${flags['keep-profile'] ? '; profile kept' : '; profile is deleted during cleanup'}.`,
      details: {
        profileId,
        name,
        browserVersion: general.profile_browser_version,
        simulatedOs: general.simulated_operating_system,
        group: general.profile_group,
        keepProfile: Boolean(flags['keep-profile']),
      },
    };
  },
);
