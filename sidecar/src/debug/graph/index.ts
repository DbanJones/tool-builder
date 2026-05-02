// Software graph composition. Builds the queryable structure G4's
// validator and future schema/auth-aware detectors consume:
//
//   buildGraph(projectPath) → { routes, schema, auth, warnings }
//
// Per-area failures (a malformed migration, an unparseable route file)
// surface as warnings rather than throws — partial graphs are useful.

import { buildAuthModel, type RouteAuthInfo } from "./auth-model.js";
import { inventoryRoutes, type RouteInfo } from "./routes.js";
import { buildSchemaGraph, type SchemaTable } from "./schema.js";

export type { AuthCheck, RouteAuthInfo } from "./auth-model.js";
export type { HttpMethod, RouteInfo, RouteKind } from "./routes.js";
export type {
  PolicyAction,
  SchemaColumn,
  SchemaPolicy,
  SchemaTable,
} from "./schema.js";

export interface GraphWarning {
  area: "routes" | "schema" | "auth";
  message: string;
}

export interface SoftwareGraph {
  routes: readonly RouteInfo[];
  schema: readonly SchemaTable[];
  auth: readonly RouteAuthInfo[];
  warnings: readonly GraphWarning[];
}

export async function buildGraph(projectPath: string): Promise<SoftwareGraph> {
  const warnings: GraphWarning[] = [];

  const routes = await inventoryRoutes(projectPath).catch((e) => {
    warnings.push({
      area: "routes",
      message: e instanceof Error ? e.message : String(e),
    });
    return [] as RouteInfo[];
  });

  const schema = await buildSchemaGraph(projectPath).catch((e) => {
    warnings.push({
      area: "schema",
      message: e instanceof Error ? e.message : String(e),
    });
    return [] as SchemaTable[];
  });

  const auth = await buildAuthModel(projectPath, routes).catch((e) => {
    warnings.push({
      area: "auth",
      message: e instanceof Error ? e.message : String(e),
    });
    return [] as RouteAuthInfo[];
  });

  return { routes, schema, auth, warnings };
}
