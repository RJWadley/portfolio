import { get, route } from "remix/routes";

export const routes = route({
  assets: get("/assets/*path"),
  home: get("/"),
  work: { show: get("/work/:slug") },
  notFound: get("/404"),
  fallback: get("/*path"),
});
