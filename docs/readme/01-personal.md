# Strata

Strata is my T3 replacement. It's where I do all of my agent work, develop software, and work through ideas with AI.

This is a solo personal project, and I keep improving it because it's the tool I use. It's open source because I think it's cool, useful, and way prettier. Maybe you'll think so too.

![Strata showing a richly rendered agent reply about a fictional saved-views feature](images/agent-workspace.png)

## Read the work. Respond where it matters.

Working with agents involves a lot of reading. Plans, explanations, comparisons, questions, and the occasional confident misunderstanding. I want those things to be easy to follow, and I want to respond at the exact point where something needs to change.

Strata renders agent replies with the same care as documents. Tables, diagrams, charts, callouts, and decision cards give the work a shape you can actually read. Themes let you change the colors, fonts, and feel of the workspace. I spend enough time here that how it looks matters to me.

![A passage selected in an agent reply, with a comment attached to the exact text](images/passage-comment.png)

Select a passage and comment on it. Annotate a plan. Point to something in a page and say what should change. Your feedback travels with the thing you're talking about, so you can spend less time explaining which paragraph, suggestion, or button you mean.

That started with Strata's document editor. The project grew because I wanted the same reading and interaction everywhere I work with agents. Documents are still part of it. Now the conversations and the rest of the work happen here too.

## The browser is here too

Strata has a built-in browser for opening the thing you're building, checking it, and giving visual feedback. Mark up a page and send the agent the screenshot, your comments, and context about what you marked.

![Strata's browser displaying a fictional project board with a visual comment](images/browser-annotation.png)

Projects, agent conversations, documents, terminals, and the browser live in the same app.

*These are real Strata windows with fictional test data.*

## Where T3 fits

Strata packages the official [T3 server](https://github.com/pingdotgg/t3code) and uses it as its agent engine. T3 handles agent sessions, provider connections, and the execution of agent work. Strata supplies its own desktop interface, rich rendering, document review, comments, and visual feedback.

**Strata is an independent application, not a fork of T3.** The T3 server is an upstream dependency that ships with it. Calling Strata my T3 replacement describes the app I work in every day. Underneath, T3 is still doing the server work, and deserves credit for it.

The bundled server runs locally with its own Strata data directory. Strata can also connect to an external T3 server. The [bundled engine notes](../../packaging/engine/README.md) cover the packaging and its current limitations.

## Try it if it sounds like your kind of tool

This project follows my own work and preferences. I intend to keep making it better because I use it, and I'm sharing it because someone else might find it useful.

Give your agent this repository and ask it to help you get started. If you aren't sure how to do something, ask your agent. The [product specification](../PRD.md) and [agent instructions](../../skills/README.md) are here for it to read.

The name is Strata now. You'll still see `stratamd` in commands, paths, and older documentation while the rename catches up.

[MIT licensed](../../LICENSE).
