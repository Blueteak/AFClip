# Chat context

`global.md` applies to every chat. `item-types/<kind>.md` applies to each anchor kind and captured media kind, including mixed selections. Available kinds include project, clip, graphic, video, audio, image, transition, marker, track, folder, point and timeline.

Files are read for every submitted message, including steering and resumed chats. Add local instructions at `%LOCALAPPDATA%/AFClip/agents/prompts/global.md` or `item-types/<kind>.md` under that directory. `AFCLIP_AGENT_HOME` overrides the agents directory. Local instructions follow the corresponding bundled file. These files configure AFClip chats only.
