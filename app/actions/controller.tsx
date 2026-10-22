import { createController } from "remix/router";

import { assets } from "../assets.ts";
import { routes } from "../routes.ts";
import { HomePage } from "./home-page.tsx";
import { NotFoundPage } from "./not-found-page.tsx";

export default createController(routes, {
  actions: {
    async assets(context) {
      return (
        (await assets.fetch(context.request)) ??
        new Response("Not Found", { status: 404 })
      );
    },
    home(context) {
      return context.render(<HomePage />);
    },
    notFound(context) {
      return context.render(<NotFoundPage />, { status: 404 });
    },
    fallback(context) {
      return context.render(<NotFoundPage />, { status: 404 });
    },
  },
});
