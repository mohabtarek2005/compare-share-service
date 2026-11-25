// Local entry point: runs the Compare & Share service as a normal Node server.
// The same app is used by the AWS Lambda handler (lambda.js).
const { buildAppFromEnv } = require('./appFromEnv');

const port = Number(process.env.PORT) || 3003;

let app;
try {
  app = buildAppFromEnv(process.env);
} catch (err) {
  // Only our own configuration messages are printed (no secrets in them).
  console.error(err.message);
  process.exit(1);
}

app.listen(port, () => {
  console.log(`Compare & Share service listening on port ${port}`);
});
