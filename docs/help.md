doobie {{VERSION}} — browser automation CLI for coding agents (Puppeteer scripts, named pages, snapshot refs)

USAGE
  doobie [flags] < script.js        run a script from stdin
  doobie [flags] -e 'code'          run inline code
  doobie [flags] run FILE           run a script file
  doobie pages | browsers | status | stop [NAME] | install | install-skill | chrome | help [topic]

FLAGS
  -b, --browser NAME      named persistent profile (default: "default")
  -c, --connect [URL]     attach to a running Chrome (auto | http://host:port | ws://... | unix:/path)
      --headless          launch headless (default: headed; config.json can flip it)
  -t, --timeout SECONDS   deadline for the whole request (default 30)
      --json              NDJSON frames instead of text
      --idle-timeout D    close a launched browser after D idle (30m default; 0 = never)
      --quiet-page        do not print page console errors/warnings
      --no-cap            do not cap stdout at 50k chars
  -V, --version           print version

## quickstart
(placeholder: the docs agent fills this in)
