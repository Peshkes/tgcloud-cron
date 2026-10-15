export const CONFIG_TEMPLATE = `{
  "$schema": "./node_modules/tgcloud-cron/schema.json",
  "jobs": {
    "example": { "schedule": "0 9 * * *", "args": { "greeting": "Good morning" } }
  }
}
`;

export const JOB_TEMPLATE = `// Runs on the schedule set in tgcron.json. Deploy it with \`npx tgcloud push\`
// like any other module; test it with \`npx tgcron run example --local\`.
//
// args: the "args" object from tgcron.json
// tick: { job, runId, scheduledAt } where scheduledAt is an ISO string, or null for a manual run
export default async function (args, tick) {
  console.log(\`\${args.greeting}: \${tick.job} run \${tick.runId}\`);
  return { ok: true };
}
`;
