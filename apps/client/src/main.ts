/** Entry point: builds the app and starts it. */
import "./style.css";
import { App, optionsFromSearch } from "./app";

const root = document.querySelector<HTMLDivElement>("#app");
if (root === null) {
  throw new Error("#app is missing from the page");
}

const worker = new Worker(new URL("./worker/parser.worker.ts", import.meta.url), {
  type: "module",
});

const app = new App(root, worker, optionsFromSearch(window.location.search));
app.start();
