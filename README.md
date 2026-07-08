# tc.fpcontrol

Easy first person control for camera and objects in "view space" with gamepad or keyboard in Max.

This is a small Max package consisting of two objects:

- [gamepad.drive] a simple abstraction that takes the output of a [gamepad] and converts it to move and turn messages in a typical jit.anim fashion. Left stick to move around, right stick to rotate, triggers to move up/down, featuring scaled radial deadzones for your quirky always-shifting Xbox sticks.

- [tc.fpcontrol]: a v8 object that:
  - takes as input move and turn messages, like the ones from [gamepad.drive], but also [jit.anim.drive] (with a small trick), or any other custom source
  - for controlling objects in camera space: if you move the left stick to the right, your object will go to the right of the screen, regardless of its orientation or the position of the camera. Like what you're generally used to in video games. You can always switch to a more classic object space mode where movements are applied relatively to the objects orientation.
  - for controlling cameras, either at the same elevation (use triggers to move up/down), either in "flymode" (goes forward in the direction you're pointing to, without elevation lock)
  - for controlling [jit.anim.node], either single ones, or within a hierarchy, allowing to control multiple objects at once.
  - featuring a customizable bounds box indicating the target object/jit.anim.node
  - gives you a list of all controllable objects in your patch. You can populate a menu from that and easily cycle through every object/anim.node to control them one by one.

## How to install

[Download](https://github.com/Teufeuleu/tc.fpcontrol/archive/refs/heads/main.zip) this repository, unzip the archive in your Max packages folder, and restart Max.
