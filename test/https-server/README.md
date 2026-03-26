# HTTPS Server Fixture

This fixture serves a minimal page over self-signed HTTPS with Vite and
`@vitejs/plugin-basic-ssl`.

Use it to manually verify that `dev-browser` fails on certificate errors by
default and succeeds when launched with `--ignore-https-errors`.
