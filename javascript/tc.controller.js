/* SPDX-License-Identifier: GPL-3.0-or-later */
/*
This js file is meant to be used in Cycling'74 Max with the [v8] object.
It provides a way to control cameras in a typical first-person fashion,
and move and turn objects in view-space.

Copyright (C) 2025 Théophile Clet <contact@tflcl.xyz> - https://tflcl.xyz

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details:
<https://www.gnu.org/licenses/gpl-3.0.txt>.
*/

autowatch = 1;

outlets = 2;

// var drawto = "";
// declareattribute({ name: "drawto", setter: "setdrawto" });

let world_bangs = false; // is the world banging?
const ctx_finder = require("implicit.context.js");
ctx_finder.register_drawto(this, dosetdrawto, set_root);

var ease = 0.1;
declareattribute({
	name: "ease",
	setter: "set_ease",
	label: "Ease",
	type: "float",
	min: 0.0,
	default: 0.1,
});

var camera = "";
declareattribute({
	name: "camera",
	setter: "set_camera",
	label: "Camera anim node",
	type: "string",
});

var flymode = 0;
declareattribute({
	name: "flymode",
	setter: "set_flymode",
	style: "onoff",
	default: 0,
});

var controlmode = 0;
declareattribute({
    name: "controlmode",
    setter: "set_controlmode",
    style: "enumindex",
    enumvals: ["View space", "Object space"],
    label: "Control Mode",
})

var show_bounds = 1;
declareattribute({
	name: "show_bounds",
	setter: "set_show_bounds",
	style: "onoff",
	default: 1,
});

const ANIMABLE_GL_OBJECTS = [
	"jit_gl_node",
	"jit_gl_mesh",
	"jit_gl_gridshape",
	"jit_gl_model",
	"jit_gl_plato",
	"jit_gl_nurbs",
	"jit_gl_text",
	"jit_gl_videoplane",
	"jit_gl_graph",
	"jit_gl_sketch",
	"jit_gl_path",
	"jit_gl_lua",
	"jit_gl_isosurf",
	"jit_gl_cornerpin",
	"jit_gl_skybox",
	"jit_gl_volume",
	"jit_gl_multiple",
	"jit_gl_light",
	"jit_gl_camera",
];

let controlled_gl_objects = []; // Used for enabling.disabling drawbounds on object(s) animated by the controller
let controllable_objects = []; // Used for listing all controllable objects in a patch

let top_level_patcher;
let ctlr;

class Controller {
	constructor(drawto) {
		this.ease = 0.1; // anim.drive easing
		this.flymode = false;
		this.flymode_applyed = false; // Flag
		this.control_obj_type; // 'cam' if the camera is the target, 'obj' otherwise

        this.world_up = [0, 1, 0];
        this.camera_target = {
            name: '',
            class: '',
            anim: '',
        }
        this.camera_node_implicit = new JitterObject("jit.anim.node"); // Used if camera isn't attached to an anim.node
        this.camera_node_implicit.name = "camera_node_implicit";
        this.camera_node = new JitterObject("jit.proxy"); // Either proxy of a jit.anim.node defined by user, or of this.camera_node_implicit
		this.cam_direction, this.cam_up, this.cam_right;

		this.camera_base_matrix;
		this.get_cam_base_matrix();

		// main_node always has its Y axis aligned with world_up direction
		// It is used with main_drive for up/down movements, Y rotation (yaw) and X-Y movements (accross an horizontal plan)
		this.main_node = new JitterObject("jit.anim.node");
		this.main_node.turnmode = "local";
		this.main_node.movemode = "local";
		this.main_node.tripod = 1; // for flymode

		this.main_drive = new JitterObject("jit.anim.drive");
		this.main_drive.drawto = drawto;
		this.main_drive.ease = this.ease;
		this.main_drive.targetname = this.main_node.name;

		// pitch_node used with pitch_drive for pitch rotation (over the objects local x axis)
		this.pitch_node = new JitterObject("jit.anim.node");
		this.pitch_node.anim = this.main_node.name;
		this.pitch_node.turnmode = "parent";
		this.pitch_node.movemode = "parent";

		this.pitch_drive = new JitterObject("jit.anim.drive");
		this.pitch_drive.drawto = drawto;
		this.pitch_drive.ease = this.ease;
		this.pitch_drive.targetname = this.pitch_node.name;

		this.target = new JitterObject("jit.proxy"); // Stores the object to control
	}

	// Taking control over a new target
	control(obj_name, obj_type) {
		if (!this.camera_target.name) {
			error("No camera defined. Cannot control object.\n");
			return false;
		}

		let new_target;
		if (obj_name != undefined) {
			new_target = get_anim_node(obj_name, this.pitch_node.name);
		}

		if (
			new_target != undefined &&
			(this.target.name != "" || this.target.name != new_target)
		) {
			this.control_obj_type = obj_type;

			if (this.target.name != "") {
				const transform = this.target.send("getworldtransform"); // Get the current targets tranfsorm,
				this.target.send("anim"); // Unbind it (makes it loose its transform part coming from Controller nodes)
				this.target.send("anim_reset"); // Reset it
				this.target.send("transform", transform); // And re-apply the transform so it stays in place
			}

			this.target.name = new_target; // Bind to new target
			this.reset(); // Reset this.Controller anim nodes
			this.main_node.position = this.target.send("getworldpos"); // Take the target position, rotatexyz and scale and pass them to this.Controller anim nodes
			let target_rotatexyz = this.target.send("getrotatexyz");
			this.main_node.rotatexyz = [0, target_rotatexyz[1], 0];
			this.pitch_node.rotatexyz = [target_rotatexyz[0], 0, target_rotatexyz[2]];
			this.pitch_node.scale = this.target.send("getscale");

			// And select the new target
			this.target.send("anim_reset");
			this.target.send("anim", this.pitch_node.name);

			// Apply specific rules depending on if controlling the camera or an object
            if (this.control_obj_type == "cam") {
                // If this.camera() is set before the jit.world starts, there is a chance that camera_node is bound to the wrong node.
                // this.camera(this.camera_target.name);
				this.main_node.movemode = "local";
				this.main_node.turnmode = "local";
				this.pitch_node.turnmode = "parent";
				this.set_flymode(this.flymode);
			} else {
				this.flymode_applyed = false;
				// When controlling an object, we convert the translation vector
				// from screen space to world space in this.move
				// So we need the cam base matrix
				if (controlmode == 0) {
    				this.main_node.movemode = "world";
    				this.main_node.turnmode = "world";
                    this.pitch_node.turnmode = "world";
    				this.get_cam_base_matrix();
				} else {
                    this.main_node.movemode = "local";
    				this.main_node.turnmode = "local";
                    this.pitch_node.turnmode = "parent";
				}
			}

			// No target
		} else if (obj_name == undefined && this.target.name != "") {
			this.target.send("anim");
			this.target.send("anim_reset");
			this.target.send("transform", this.pitch_node.worldtransform);
			this.target.name = "";
		}
        outlet(0, "control", obj_name, this.target.name);
        return true;
	}

    camera(obj_name) {
        if (obj_name === this.camera_target.name) return;
        // Is it a camera or a node?
        const proxy = new JitterObject("jit.proxy");
    	proxy.name = obj_name;
    	const proxy_class = proxy.class;
        let target = null;
        if (proxy_class == "jit_anim_node") {
            // If user passed an anim.node as camera, we use it directly.
            target = obj_name;
        } else if (proxy_class == "jit_gl_camera") {
            // If it's a jit_gl_camera, we get its world transform from its parent node (whether it is implicit or user-defined),
            const cam_anim = new JitterObject("jit.proxy");
            cam_anim.name = proxy.send("getanim");
            const transform = cam_anim.send("getworldtransform");
            cam_anim.freepeer();
            // Then we attach our camera_node_implicit to the camera and restore its world transform
            // this.camera_node_implicit.anim_reset();
            proxy.send("anim_reset");
            proxy.send("anim", this.camera_node_implicit.name);
            this.camera_node_implicit.transform = transform;
            target = this.camera_node_implicit.name;
        }
        if (target) {
            this.camera_node.name = target;
    		this.camera_node.send("animmode", "world");
            this.get_cam_base_matrix();
            this.camera_target.name = proxy.name;
            this.camera_target.class = proxy.class;
            this.camera_target.anim = proxy.anim;
            camera = target;
        } else {
            this.unbind_camera();
        }
		proxy.freepeer();
    }

    unbind_camera() {
        if (this.camera_target.name) {
            if (this.camera_target.class === "jit_anim_node") {
                // If user passed an anim node as camera target, we just unbind our proxy from it
                this.camera_node.name = "";
            } else if (this.camera_target.class === "jit_gl_camera") {
                // If it was a camera, we set it back as it was, but with the current transform
                const transform = this.camera_node.send("getworldtransform");
                const cam = new JitterObject("jit.proxy");
                cam.name = this.camera_target.name;
                cam.send("anim");
                cam.send("anim_reset");
                const cam_anim = new JitterObject("jit.proxy");
                cam_anim.name = cam.send("getanim");
                cam_anim.send("transform", transform);
                cam.freepeer();
                cam_anim.freepeer();
            }
            this.control();
            this.camera_target.name = "";
            this.camera_target.class = "";
            this.camera_target.anim = "";
            camera = "";
        }
    }

	get_cam_base_matrix() {
		if (this.camera_node.name != "") {
            this.cam_direction = this.camera_node.send("getdirection");
			this.cam_direction[1] = 0;
			this.cam_direction = normalize(this.cam_direction);
			this.cam_right = normalize(cross(this.cam_direction, this.world_up));
			this.cam_up = normalize(cross(this.cam_right, this.cam_direction));
			this.camera_base_matrix = [
				this.cam_right,
				this.cam_up,
				this.cam_direction,
			];
		}
	}

	move(x, y, z) {
		let translat_vec = [x, y, z];
		if (this.control_obj_type == "obj" && controlmode == 0) {
			let cam_x_rot = this.camera_node.send("getrotatexyz")[0];
			// Inverse translation direction if cam is upside down
			if (cam_x_rot < -90 || cam_x_rot > 90) {
				x *= -1;
				z *= -1;
			}
			translat_vec = multiplyMatrixVector(this.camera_base_matrix, [x, 0, -z]);
		}
		this.main_drive.move(translat_vec[0], y, translat_vec[2]);
	}

	turn(x, y, z) {
		let rot_vec = [x, y, z];
		if (this.control_obj_type == "obj") {
			rot_vec = multiplyMatrixVector(this.camera_base_matrix, [-x, 0, 0]);
			rot_vec[1] = -y;
		}
		if (this.flymode && this.control_obj_type == "cam") {
			// When flymode is enabled, we apply all rotations to the main_node
			// so that the cam can move toward the direction it is pointing to
			this.main_drive.turn(rot_vec[0], rot_vec[1], 0);
			this.pitch_drive.turn(0, 0, 0);
		} else {
			this.main_drive.turn(0, rot_vec[1], 0);
			this.pitch_drive.turn(rot_vec[0], 0, rot_vec[2]);
		}
	}

	elev(y) {
		this.main_drive.move([0, y, 0]);
	}

	set_flymode(v) {
		// When enabled, the camera can move toward any direction it faces.
		// When disabled, it should not move on the world y axis ("walk mode") unless explicitely sending move messages with non-null Y component.
		if (v == 1) {
			this.flymode = true;
		} else {
			this.flymode = false;
		}
		this.apply_flymode();
	}

	apply_flymode() {
		if (this.control_obj_type == "cam") {
			if (this.flymode) {
				// When enabling flymode, we move all rotations to main_node
				this.main_node.rotatexyz = [
					this.pitch_node.rotatexyz[0],
					this.main_node.rotatexyz[1],
					0,
				];
				this.pitch_node.anim_reset();
				this.flymode_applyed = true;
			} else if (this.flymode_applyed) {
				// And we revert when disabling
				let rotatexyz = this.main_node.rotatexyz;
				this.pitch_node.anim_reset();
				this.pitch_node.rotatexyz = [rotatexyz[0], 0, 0];
				this.main_node.rotatexyz = [0, rotatexyz[1], rotatexyz[2]];
				this.flymode_applyed = false;
			}
		}
	}

	set_drawto(v) {
		this.main_drive.drawto = v;
		this.pitch_drive.drawto = v;
	}

	set_ease(v) {
		this.ease = v;
		this.main_drive.ease = this.ease;
		this.pitch_drive.ease = this.ease;
	}

	reset() {
		this.main_node.anim_reset();
		this.pitch_node.anim_reset();
	}

	resync() {
		if (this.target.name != "") {
			this.control(this.target.name, this.control_obj_type);
		}
	}

	destroy() {
		if (this.target.name != "") {
			this.target.send("anim");
			this.target.send("transform", this.pitch_node.worldtransform);
        }
        this.camera_node_implicit.freepeer();
		this.main_node.freepeer();
		this.main_drive.freepeer();
		this.pitch_node.freepeer();
		this.pitch_drive.freepeer();
		this.target.freepeer();
	}
}

loadbang();

// Select the object to use as basis for view-space transforms
function set_camera(name) {
	camera = name;
	if (world_bangs) {
	    ctlr.camera(name);
	}
}

// Select which object to control in view-space
function control(obj_name) {
	ctlr.control(obj_name, "obj");
	if (show_bounds) {
		do_show_bounds(0);
	}
	controlled_gl_objects = [];
	get_gl_obj_controlled_by_ctlr();
	if (show_bounds) {
		do_show_bounds(show_bounds);
	}
}

// Select which camera to control
function control_camera(obj_name) {
	if (obj_name !== undefined) {
		const answer = ctlr.control(obj_name, "cam");
		if (answer) do_show_bounds(0);
	}
}

// Output from the second outlet a list of all controllable jit.gl and jit.anim.node objects in the entire patcher hierarchy
function controllable() {
	controllable_objects = [];
	top_level_patcher.applydeepif(
		add_to_controllable_list,
		is_controllable_applydeepif
	);
	outlet(1, "controllable");
	for (let obj of controllable_objects) {
		outlet(1, obj.maxclass, obj.getattr("name"));
	}
	outlet(1, "done");
}

function add_to_controllable_list(obj) {
	controllable_objects.push(obj);
}
add_to_controllable_list.local = 1;

function is_controllable_applydeepif(obj) {
	return (
		obj.maxclass == "jit.anim.node" ||
		is_controllable(obj.maxclass.replaceAll(".", "_"))
	);
}
is_controllable_applydeepif.local = 1;

function resync() {
	ctlr.resync();
}

function reset() {
	ctlr.reset();
}

function move(x, y, z) {
	ctlr.move(x, y, z);
}

function turn(x, y, z) {
	ctlr.turn(x, y, z);
}

function elev(v) {
	ctlr.elev(v);
}

function anim_move(x, y, z, t) {
    ctlr.move(x, y, z);
}
function anim_turn(x, y, z, t) {
    ctlr.turn(x, y, z);
}

function set_ease(v) {
	ctlr.set_ease(v);
	ease = v;
}
set_ease.local = 1;

function set_flymode(v) {
	flymode = v == undefined ? !flymode : v == 1; // If flymode with no argument is provided, act as a toggle
	ctlr.set_flymode(flymode);
}
set_flymode.local = 1;

function set_show_bounds(v) {
	show_bounds = v == true;
	// ctlr.show_bounds = show_bounds;
	do_show_bounds(show_bounds);
}
set_show_bounds.local = 1;

function set_controlmode(v) {
    const new_val = v > 0 ? 1 : 0;
    if (controlmode === new_val) return;
    controlmode = new_val;
    ctlr.control(ctlr.target.name, ctlr.control_obj_type);
}

function do_show_bounds(v) {
	const objects_without_bounds = [
		"jit.gl.sketch",
		"jit.gl.skybox",
		"jit.gl.camera",
	];
	for (const obj of controlled_gl_objects) {
		if (!objects_without_bounds.includes(obj.maxclass)) {
			obj.setattr("drawbounds", v);
		}
	}
}
do_show_bounds.local = 1;

function bang() {
	outlet(0, ctlr.pitch_node.worldtransform);
}

function loadbang() {
	if (!top_level_patcher) {
		top_level_patcher = get_top_level_patcher();
		ctlr = new Controller(drawto);
	}
}

function notifydeleted() {
	ctlr.destroy();
	ctx_finder.dispose();
	if (ctx_lstnr) ctx_lstnr.freepeer();
	// implicit_tracker.freepeer();
}

/////////////////////////////////////////////
// HELPER METHODS
/////////////////////////////////////////////

function get_anim_node(jit_obj_name, ctlr_node) {
	const proxy = new JitterObject("jit.proxy");
	proxy.name = jit_obj_name;
	const proxy_class = proxy.class;
	proxy.freepeer();
	if (proxy_class == "jit_anim_node") {
		return jit_obj_name;
	} else if (proxy_class != "" && is_controllable(proxy_class)) {
		const context_anim = get_context_anim(jit_obj_name);
		return get_top_level_anim_node(jit_obj_name, context_anim, ctlr_node);
	}
	return;
}
get_anim_node.local = 1;

function is_controllable(obj_class) {
	// Using jit.proxy syntax (ie 'jit_gl_mesh' and not 'jit.gl.mesh')
	return ANIMABLE_GL_OBJECTS.includes(obj_class);
}
is_controllable.local = 1;

function get_context_anim(jit_obj_name) {
	// Get the first implicit jit.anim.node level for the object's rendering context
	const proxy = new JitterObject("jit.proxy");
	proxy.name = jit_obj_name;
	proxy.name = proxy.send("getdrawto");
	const context_name = proxy.send("getanim");
	proxy.freepeer();
	return context_name;
}
get_context_anim.local = 1;

function get_top_level_anim_node(jit_obj_name, context_anim, ctlr_node) {
	// Recursively get the top level jit.anim.node before reaching context_anim, or no anim.node, or this.pitch_node (if trying to controller currently controlled object)
	const proxy = new JitterObject("jit.proxy");
	proxy.name = jit_obj_name;
	const parent_name = proxy.send("getanim").toString();
	proxy.freepeer();
	if (
		parent_name == "" ||
		parent_name == context_anim ||
		parent_name == ctlr_node
	) {
		return jit_obj_name;
	} else {
		return get_top_level_anim_node(parent_name, context_anim, ctlr_node);
	}
}
get_top_level_anim_node.local = 1;

function get_top_level_patcher() {
	let prev = 0;
	let owner = this.patcher.box;
	while (owner) {
		prev = owner;
		owner = owner.patcher.box;
	}
	return prev ? prev.patcher : this.patcher;
}
get_top_level_patcher.local = 1;

// Get gl object(s) controlled by ctlr (for the sole purpose of drawing bounds of selected object)
function get_gl_obj_controlled_by_ctlr() {
	top_level_patcher.applydeepif(
		add_to_controlled_obj_list,
		is_controlled_by_ctlr
	);
}
get_gl_obj_controlled_by_ctlr.local = 1;

function is_controlled_by_ctlr(obj) {
	if (is_controllable(obj.maxclass.replaceAll(".", "_"))) {
		const obj_anim = obj.getattr("anim");
		if (obj_anim == ctlr.pitch_node.name) {
			return true;
		} else if (obj_anim != "") {
			const proxy = new JitterObject("jit.proxy");
			proxy.name = obj_anim;
			const parent_name = proxy.send("getanim").toString();
			proxy.freepeer();
			return parent_name == ctlr.pitch_node.name;
		}
	}
	return false;
}
is_controlled_by_ctlr.local = 1;

function add_to_controlled_obj_list(obj) {
	controlled_gl_objects.push(obj);
}
add_to_controlled_obj_list.local = 1;

/////////////////////////////////////////////
// MATHS
/////////////////////////////////////////////

function normalize(v) {
	const len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
	if (len === 0) return v;
	return [v[0] / len, v[1] / len, v[2] / len];
}
normalize.local = 1;

function cross(a, b) {
	return [
		a[1] * b[2] - a[2] * b[1],
		a[2] * b[0] - a[0] * b[2],
		a[0] * b[1] - a[1] * b[0],
	];
}
cross.local = 1;

function dot(a, b) {
	return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
dot.local = 1;

function multiplyMatrixVector(matrix, vector) {
	return [
		dot(matrix[0], vector),
		dot(matrix[1], vector),
		dot(matrix[2], vector),
	];
}
multiplyMatrixVector.local = 1;

/////////////////////////////////////////////
// GL Context
/////////////////////////////////////////////
let ctx_root;
let ctx_lstnr;
function set_root(new_root) {
    ctx_root = new_root;
    if (ctx_lstnr) {
        ctx_lstnr.freepeer();
        ctw_lstnr = null;
    }
    ctx_lstnr = new JitterListener(new_root, ctx_callback);
}
set_root.local = 1;

function ctx_callback(event) {
    switch (event.eventname) {
        case "swap": case "draw":
            if (!world_bangs) {
                // First world bang: world initialized, we can set the camera
                world_bangs = true;
                set_camera(camera);
            }
            break;
        // case "mouse":   

        //     break;
        // case "mouseidle": 
            
        //     break;

        // case "keydown":
        //     // FF_Utils.Print("KEYDOWN", (event.args[0]));
        //     break;

        // case "willfree":
        //     break;
            
        default:
        //     post(event.args); post();
            break;
    }
}
ctx_callback.local = 1;

// let implicitdrawto = "";
// let explicitdrawto = false;
// const implicit_tracker = new JitterObject("jit_gl_implicit");
// const implicit_lstnr = new JitterListener(
// 	implicit_tracker.name,
// 	implicit_callback
// );
// const ctx_proxy = new JitterObject("jit.proxy");

// function implicit_callback(event) {
// 	if (!explicitdrawto && implicitdrawto != implicit_tracker.drawto[0]) {
// 		// important! drawto is an array so get first element
// 		implicitdrawto = implicit_tracker.drawto[0];
// 		dosetdrawto(implicitdrawto);
// 	}
// }
// implicit_callback.local = 1;

// function setdrawto(val) {
//     if (val) {
//         explicitdrawto = true;
//         dosetdrawto(val);
//     } else {
//         explicitdrawto = false;
//     }
// }
// setdrawto.local = 1;

function dosetdrawto(arg) {
	if (arg === drawto || !arg) {
		// bounce
		return;
	}

	drawto = arg;
	ctlr.set_drawto(drawto);
	ctx_proxy.name = drawto;
	
}
// dosetdrawto.local = 1;
