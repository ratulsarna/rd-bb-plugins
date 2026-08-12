import { definePluginApp } from "@bb/plugin-sdk/app";
import { FavoritesPanel } from "@/components/favorites-panel";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "favorites",
    title: "Favorites",
    icon: "Star",
    path: "favorites",
    component: FavoritesPanel,
  });
});
