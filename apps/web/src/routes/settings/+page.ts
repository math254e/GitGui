import { redirect } from "@sveltejs/kit";
import type { PageLoad } from "./$types";

/** The settings index has no page of its own; it opens the first section. */
export const load: PageLoad = ({ url }) => {
  redirect(307, `/settings/general${url.search}`);
};
