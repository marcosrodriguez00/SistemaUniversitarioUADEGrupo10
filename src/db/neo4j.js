import 'dotenv/config';
import neo4j from 'neo4j-driver';

let driver;

export async function connect() {
  if (!driver) {
    driver = neo4j.driver(
      process.env.NEO4J_URL,
      neo4j.auth.basic(process.env.NEO4J_USER, process.env.NEO4J_PASSWORD)
    );
    await driver.verifyConnectivity();
  }
  return driver;
}

export async function close() {
  if (driver) { await driver.close(); driver = null; }
}