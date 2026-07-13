export const serviceName = "clank";

if (process.argv[1] === import.meta.filename) {
  console.log(`${serviceName} bootstrap ready`);
}
