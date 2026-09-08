# Strata

Strata is where I do all of my agent work. It's my T3 replacement, and the tool I use to build software and work through ideas with AI.

Conversations, documents, terminals, and a browser are all here. I wanted a place where it was easier to read what agents wrote and respond to it. I also wanted it to look good. I spend a lot of time here.

![An agent conversation in Strata with a rendered recommendation and comparison](images/agent-workspace.png)

## Easier to read

Agents write a lot. Some of it needs a careful read, and some of it just needs a quick skim to catch the part where things went sideways.

Strata gives those replies some structure. Tables, diagrams, charts, callouts, and comparison cards render right in the conversation. The same rendering works in documents, so a plan is as readable as the discussion around it.

You can change the themes, colors, and fonts to suit your taste. How it looks is a big part of why I like using it.

## Point at what you mean

When an agent gets something wrong, I want to point at it and say what needs to change. Having to explain which paragraph I'm talking about gets old.

In Strata, you can select part of a reply and comment on it, or annotate a document and review the agent's changes there. The relevant text goes with your feedback.

You can annotate photos and screenshots too. Paste or attach an image, mark a region, draw on it, or add an arrow, then leave a comment about what you're pointing at. The agent gets the image with your marks and comments together.

You can keep prompting as usual, but you don't have to turn every small correction into another explanation.

![Leaving a comment on a specific passage in a Strata conversation](images/passage-comment.png)

This is what the original Strata document editor did well. I liked working that way enough to bring it into conversations and the rest of my agent work.

## A browser, too

Strata has a built-in browser, so you can open what you're building without leaving the app. You can mark up the page and send the agent a screenshot with your comments. When you mark an element, Strata can include context about that part of the page too.

![Visual feedback on a fictional project board inside Strata's browser](images/browser-annotation.png)

*All screenshots show real Strata windows using fictional test data.*

## How T3 fits

Strata packages the official [T3 server](https://github.com/pingdotgg/t3code) and uses it to run agent sessions and handle provider connections. Strata provides its own desktop interface, rich rendering, review tools, comments, and browser interaction.

It's an independent app, not a fork of T3. When I call it my T3 replacement, I mean it's the app I work in. The T3 server is still underneath it, doing the agent work, and deserves credit for that.

The bundled server runs locally with its own Strata data directory. You can also connect to an external T3 server. The [packaging notes](../../packaging/engine/README.md) have the details and current limitations.

## A personal project

This is a solo personal project. I think it's cool, useful, and way prettier, so I'm sharing it. Maybe someone else will feel the same way.

I intend to keep improving it because it's the tool I use. What I work on next tends to come from something I wanted while using it.

If you'd like to try it, give your agent this repository and ask it to help you get started. If you're not sure how something works, ask your agent. The [project documentation](../PRD.md) is there for it to read.

We're dropping the MD from the name. Commands, paths, and some older docs still say `stratamd` for now.

[MIT license](../../LICENSE) · [Agent instructions](../../skills/README.md)
