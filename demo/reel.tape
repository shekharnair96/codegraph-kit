Output demo/reel.gif

Set Shell "bash"
Set FontSize 16
Set Width 1200
Set Height 620
Set Theme "Dracula"
Set Padding 20
Set TypingSpeed 40ms

# Neutral prompt: no machine/user/absolute-path leakage into the recording.
Env PS1 "$ "
Hide
Type "cd demo && export PS1='$ ' && clear"
Enter
Sleep 500ms
Show

Type "./reel.sh"
Sleep 500ms
Enter

# reel.sh -> reel.mjs paces itself (REEL_DELAY_MS, default 450ms) while it
# replays the captured stream (8 tool-call lines -> ~4.2s), so just wait for
# it to finish. Re-measure this if runs/rhf-taskB-kg.stream.jsonl changes.
Sleep 5s

# Hold the final frame so the summary is readable.
Sleep 4s
