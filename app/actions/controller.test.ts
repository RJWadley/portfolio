import * as assert from "remix/assert";
import { describe, it } from "remix/test";

import { router } from "../router.ts";
import { routes } from "../routes.ts";

describe("root controller", () => {
  it("GET / returns the home page", async () => {
    let response = await router.fetch(
      new URL(routes.home.href(), "http://localhost"),
    );

    assert.equal(response.status, 200);
    assert.match(response.headers.get("Content-Type") ?? "", /text\/html/);
    assert.match(await response.text(), /<html[\s>]/);
  });
  it("returns the branded 404 for unknown paths and work slugs", async () => {
    for (const path of ["/missing", "/work/missing", routes.notFound.href()]) {
      const response = await router.fetch(new URL(path, "http://localhost"));
      assert.equal(response.status, 404);
      assert.match(response.headers.get("Content-Type") ?? "", /text\/html/);
      assert.match(await response.text(), /Page not found\./);
    }
  });
});
