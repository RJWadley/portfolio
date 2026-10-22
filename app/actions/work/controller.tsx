import { createController } from "remix/router";
import { routes } from "../../routes.ts";
import { CaseStudy } from "./show-page.tsx";
import { NotFoundPage } from "../not-found-page.tsx";
export default createController(routes.work, {
  actions: {
    show(context) {
      if (context.params.slug !== "new-form")
        return context.render(<NotFoundPage />, { status: 404 });
      return context.render(<CaseStudy />);
    },
  },
});
