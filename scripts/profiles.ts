// List, inspect, create and clean up Incogniton profiles from the command line.
//   npm run profiles -- list [--json] [--search <text>]
//   npm run profiles -- show <profileId>
//   npm run profiles -- status <profileId>
//   npm run profiles -- create [--name <name>]          (records the ID in .incogniton/created-profiles.json)
//   npm run profiles -- created                          (profiles this checkout created)
//   npm run profiles -- delete-created [--yes]           (deletes ONLY recorded profiles)
// Output never includes proxy credentials or cookie data.
import { parseArgs } from 'node:util';
import { flagOverrides, loadConfig } from '../lib/config.js';
import { EXIT_CODES, failureKindOf, fromSdkError } from '../lib/errors.js';
import { createApi, getProfileStatus } from '../lib/incogniton.js';
import { createRecordedProfile, deleteRecordedProfile } from '../lib/profiles.js';
import { reportFatal } from '../lib/run.js';
import { readCreatedProfiles } from '../lib/state.js';

const { values, positionals } = parseArgs({
  options: {
    json: { type: 'boolean' },
    search: { type: 'string' },
    name: { type: 'string' },
    yes: { type: 'boolean' },
    port: { type: 'string' },
  },
  allowPositionals: true,
});
const [command = 'list', argument] = positionals;

interface General {
  browser_id?: string;
  profile_name?: string;
  profile_group?: string;
  profile_browser_version?: string;
  simulated_operating_system?: string;
  profile_last_edited?: string;
}

/** Only non-sensitive identification fields. */
function summarize(profile: { general_profile_information?: General; Proxy?: { connection_type?: string } }) {
  const g = profile.general_profile_information ?? {};
  return {
    id: g.browser_id ?? '',
    name: g.profile_name ?? '',
    group: g.profile_group ?? '',
    browserVersion: g.profile_browser_version ?? '',
    os: g.simulated_operating_system ?? '',
    proxyType: profile.Proxy?.connection_type ?? '',
    lastEdited: g.profile_last_edited ?? '',
  };
}

try {
  const config = loadConfig(flagOverrides({ port: values.port }));
  const api = createApi(config);

  if (command === 'list') {
    let response: { profileData?: unknown[] };
    try {
      // SDK: client.profile.list(). The wire key is `profileData` (the 1.0.17 typings say `profiles`).
      response = (await api.client.profile.list()) as unknown as { profileData?: unknown[] };
    } catch (error) {
      throw fromSdkError(error, 'Listing profiles', api.port);
    }
    const search = values.search?.toLowerCase();
    const rows = (response.profileData ?? [])
      .map((p) => summarize(p as Parameters<typeof summarize>[0]))
      .filter((p) => !search || p.name.toLowerCase().includes(search) || p.group.toLowerCase().includes(search));
    if (values.json) {
      console.log(JSON.stringify(rows, null, 2));
    } else {
      console.log(`${rows.length} profile(s). Columns: ID | name | group | browser version | simulated OS`);
      for (const p of rows) console.log(`${p.id} | ${p.name} | ${p.group} | ${p.browserVersion} | ${p.os}`);
      console.log('\nUse a dedicated test profile: npm run setup -- --profile-id <ID>');
      console.log('Narrow the list with --search <text>; --json prints the same fields as JSON.');
    }
  } else if (command === 'show' || command === 'status') {
    if (!argument) throw new Error(`Usage: npm run profiles -- ${command} <profileId>`);
    const status = await getProfileStatus(api, argument);
    if (command === 'status') {
      console.log(status);
    } else {
      const { profileData } = (await api.client.profile.get(argument)) as { profileData: Parameters<typeof summarize>[0] };
      console.log(JSON.stringify({ ...summarize(profileData), status }, null, 2));
    }
  } else if (command === 'create') {
    const name = values.name ?? `starter-test-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`;
    const id = await createRecordedProfile(api, { name, createdBy: 'scripts/profiles.ts create' });
    console.log(values.json ? JSON.stringify({ id, name }) : `Created profile ${id} (${name}). Recorded in .incogniton/created-profiles.json.\nUse it: npm run setup -- --profile-id ${id}`);
  } else if (command === 'created') {
    const records = readCreatedProfiles();
    if (values.json) console.log(JSON.stringify(records, null, 2));
    else if (records.length === 0) console.log('No profiles created by this checkout.');
    else for (const r of records) console.log(`${r.profileId} | ${r.name} | created ${r.createdAt} by ${r.createdBy}`);
  } else if (command === 'delete-created') {
    const records = readCreatedProfiles();
    if (records.length === 0) {
      console.log('Nothing to delete.');
    } else if (!values.yes) {
      console.log(`Would delete ${records.length} profile(s) created by this checkout:`);
      for (const r of records) console.log(`  ${r.profileId} | ${r.name}`);
      console.log('Re-run with --yes to delete them.');
    } else {
      let failures = 0;
      for (const r of records) {
        const report = await deleteRecordedProfile(api, r.profileId, { stopTimeoutMs: config.stopTimeoutMs });
        console.log(`${report.ok ? 'deleted' : 'FAILED '} ${r.profileId} | ${r.name}${report.error ? ` (${report.error})` : ''}`);
        if (!report.ok) failures++;
      }
      process.exitCode = failures ? EXIT_CODES.cleanup_failed : 0;
    }
  } else {
    console.error(`Unknown command "${command}". Use list, show, status, create, created or delete-created.`);
    process.exitCode = EXIT_CODES.config_invalid;
  }
} catch (error) {
  reportFatal('profiles', error);
  process.exitCode = EXIT_CODES[failureKindOf(error)];
}
