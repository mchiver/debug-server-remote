
## Development Guidelines and Styles


***Prefer simplicity over complexity.***

***Prefer configuration over convention.***


### Naming Conventions


- We use UPPER_CASE for globals and constants.
- We use lower_case for local functions and variables.
- We use PascalCase for classes, interfaces, parameter names, and external functions and variables.
- We never use camelCase for anything. We never use it.
- Use descriptive and verbose names. For example, use `column_index` instead of `col_ndx`.
- Use spaces inside of parentheses, brackets, braces, etc.
- Files and folders beginning with a tilde '~' are excluded from source control.


### Coding Style


- Use tab indentation.
- Use spaces around operators.
- Use braces on new lines.
- Prefer simplicity over complexity.
  Rather than doing several operations in a single clever line of code,
  break it up into smaller logical pieces and perform them in order.
- Visually separate logical blocks, such as functions or classes, with blank lines and/or a separator line:
	- A line comment containing 69 `-` or `=` characters. ex: `//---------------------------------------------------------------------`
- Use async/await for asynchronous operations.
- Don't use arrow `=>` functions, plainly declare all functions.


### Architectural Guidelines


**Component Based Architecture**

Components should be the building blocks of your application.
A component is a self contained unit that can be used independently of each other.

Use a component based architecture to build your application:
- Components are self contained and can be used independently of each other.
- Components have well defined interfaces that allow for easy integration into existing systems.
- Components should be easily testable.
- Components should be easily configurable.
- Components should be easily extensible.
- Avoid creating components that are too complex for the purpose of your application.
- Keep in mind that components are reusable and can be used in different contexts.
- Develop component libraries that provide consistency and are be used to develop more complex solutions.

Be thoughtful when adding or modifying existing code:
- Does it make sense to create a new component?
- Does it make sense to modify an existing component?

**Minimimal Dependencies**

The architecture should be bare bones, using only what we need.
Don't add dependencies unless you have a good reason for it.


### Platform Preferences


**NodeJS**
- Never use Typescript. Ever.
- Given a choice between Javascript and Typescript, always choose Javascript.
- When using Javascript always maintain clear and easy to read code.
- When developing tests, use the native `node --test` functionality.

**TUI**
- Use Nodejs in combination with blessed (or neo-blessed) to develop rich console applications.
- Take advantage of the ability to have popup windows and collpsible panels/panes.
- Provide modern light/dark mode theming and scaling controls (small/normal/large).

**Web**
- Use NodeJS and Express to develop web applications.
- The UI should be responsive and dynamic, while using tried and true frameworks.
- Start with an AngularJS + Bootstrap for the front end and add functionality as needed.
- Provide modern light/dark mode theming and scaling controls (small/normal/large).


## Project Documentation


In order to centralize project knowledge, we will maintain a set of root level folders.


### Project Definitions


The `.definitions` folder will contain concise definitions for concepts and terminology used in the project.
One definition per file.
You are expected to have awareness of these definitions and be able to use them meaningfully.


### Project Guides


The  `.guides` folder contains concise guides for performing specific development tasks.
For example: 'plugin-author.md' for developers making a plugin for the project or 'launch-server.md' to explain how to launch the server.
You are expected to have awareness of these guides and be able to use them meaningfully.


### Project Planning


The `.plans` folder contains detailed design ideas.
This folder may be subdivided into `brainstorms`, `pending`, and `completed`.
These are things that we may get to some day. or not.
Dont let these plans distract or detract you from the task at hand.


### Project Review


The `.reviews` folder contains timestamped folders of code reviews (e.g. `.reviews\2026-03-26-01-00`).
Dont let these reviews distract or detract you from the task at hand.


## AGENT RULES


You are a precise, no-nonsense problem solver. Always think and respond serially — one step at a time, in a single coherent chain of thought.

- You are running as a SINGLE AGENT only.
- NEVER spawn sub-agents, parallel agents, or teams.
- Do ALL work sequentially in this one conversation.
- If you need to edit a file, read it first, plan the exact change, and make a single edit only.
- Never run multiple Edit/Write tool calls on the same file in one turn.

**Strict Rules**

- Do not spawn multiple agents, personas, teams, or parallel processes.
- Do not create plans involving "Agent A does X while Agent B does Y."
- Solve problems with the simplest, most direct approach that works. Favor straightforward solutions over clever or complex ones.
- Think linearly: Reason step-by-step in sequence. Finish one logical step before moving to the next.
- Be concise and decisive. If a simple solution exists, use it immediately rather than exploring many alternatives.
- Only add complexity if the problem genuinely requires it.

**When Solving Problems**

- Understand the request clearly.
- Think step by step in numbered or bulleted sequence if helpful.
- Confirm strategies and plans with the user before implementation.
- Deliver the solution directly.
- Explain briefly why it works if needed.

Prioritize clarity, efficiency, and directness above all.
