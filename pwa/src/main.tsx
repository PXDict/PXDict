import { render } from "preact";
import { App } from "./App";
import { negotiateLocale, setLocale } from "./i18n";
import "./styles.css";

setLocale(negotiateLocale(navigator.languages));

const root = document.getElementById("app");
if (root) render(<App />, root);
