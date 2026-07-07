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

let controllable_objects = []; // Used for listing all controllable objects in a patch

let top_level_patcher;
let ctlr;

class Controller {
	constructor(drawto) {
		this.ease = 0.1; // anim.drive easing
		this.flymode = false;
		this.flymode_applyed = false; // Flag
		this.control_obj_type; // 'cam' if the camera is the target, 'obj' otherwise

		this.root_anim_node = null; // The implicit drawto context anim node

        this.world_up = [0, 1, 0];
        this.camera_target = {
            name: '',
            class: '',
            anim: '',
        }
        this.camera_node_implicit = new JitterObject("jit.anim.node"); // Used if camera isn't attached to an anim.node (using the pre-made anim node of a jit.gl.camera doesn't work for some reason, so we use our own "implicit" one)
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
        this.pitch_node.name = "fp_pitch_node";
		this.pitch_node.anim = this.main_node.name;
		this.pitch_node.turnmode = "parent";
		this.pitch_node.movemode = "parent";

		this.pitch_drive = new JitterObject("jit.anim.drive");
		this.pitch_drive.drawto = drawto;
		this.pitch_drive.ease = this.ease;
		this.pitch_drive.targetname = this.pitch_node.name;

        this.target = new JitterObject("jit.proxy"); // Stores the object to control (always an anim.node)
        this.last_target_anim_node = null;  // Stores which parent anim.node was bound to our target, so we can restore it later
        this.target_type; // Class of the target object

        // For displaying bounds, we rely on our own jit.gl.mesh cube. It's simpler than keeping track of each objects draw_bounds attribute, and we can customize its appearance.
        this.show_bounds = show_bounds;
        this.cube_matrix = new JitterMatrix(3, "float32", 8);
        const cube_points = new Float32Array([-1., -1., 1., 1., -1., 1., 1., 1., 1., -1., 1., 1., -1., -1., -1., 1., -1., -1., 1., 1., -1., -1., 1., -1.]);
        this.cube_matrix.copyarraytomatrix(cube_points);
        this.cube_indexes = new JitterMatrix(1, "char", 24);
        const cube_point_indexes = new Uint8Array([0, 1, 1, 2, 2, 3, 3, 0, 0, 4, 1, 5, 2, 6, 3, 7, 4, 5, 5, 6, 6, 7, 7, 4]);
        this.cube_indexes.copyarraytomatrix(cube_point_indexes);
        this.bounds = new JitterObject("jit.gl.mesh");
        this.bounds.drawto = drawto;
        this.bounds.draw_mode = "lines";
        this.bounds.vertex_matrix(this.cube_matrix.name);
        this.bounds.index_matrix(this.cube_indexes.name);
        this.bounds.anim = this.pitch_node.name;
        this.bounds.enable = 0;
        
        this.dummy_node = new JitterObject("jit.anim.node"); // Only used for quat to euler conversion
	}

	// Taking control over a new target
	control(obj_name, obj_type) {
		if (!this.camera_target.name) {
			error("No camera defined. Cannot control object.\n");
			return false;
        }

		// Make sure the requested object is a jit.anim.node or a controllable object (a jit.gl object with an anim attribute)
		let new_target;
		if (obj_name != undefined) {
            const p = new JitterObject("jit.proxy");
            p.name = obj_name;
            if (p.class === "jit_anim_node") {
                new_target = obj_name;
            } else if (p.class && is_controllable(p.class)) {
                new_target = p.send("getanim");
            };
            this.target_type = p.class;
            p.freepeer();
		}

		if (
			new_target != undefined &&
			(this.target.name != "" || this.target.name != new_target)
        ) {
            // New object to target
			this.control_obj_type = obj_type;
            if (this.target.name != "") {
                // If there is already a targeted object, we unbind it and make it preserve its transform
                const world_pos = this.target.send("getworldpos");
                const world_quat = this.target.send("getworldquat");
                const world_scale = this.target.send("getworldscale");
            
                if (this.last_target_anim_node) {
                    this.target.send("anim", this.last_target_anim_node);
                } else {
                    this.target.send("anim");
                }
                this.target.send("anim_reset");
            
                const local = this.world_to_local(this.last_target_anim_node, world_pos, world_quat);
                this.target.send("position", local.pos);
                this.target.send("quat", local.quat);
                this.target.send("scale", world_scale);
            }

            this.target.name = new_target; // Bind to new target
            this.reset(); // Reset controller anim nodes

            // Get target transform
            const world_pos = this.target.send("getworldpos");
            const world_quat = this.target.send("getworldquat");
            const world_scale = this.target.send("getworldscale");
            
            this.dummy_node.quat = world_quat;
            const world_rotatexyz = this.dummy_node.rotatexyz;

            // Apply it to our control nodes
            this.main_node.position = world_pos;
            this.main_node.rotatexyz = [0, world_rotatexyz[1], 0];
            this.pitch_node.rotatexyz = [world_rotatexyz[0], 0, world_rotatexyz[2]];
            this.pitch_node.scale = world_scale;

            // And select the new target
            this.last_target_anim_node = this.target.send("getanim");
            this.target.send("anim_reset");
            this.target.send("anim", this.pitch_node.name);
            this.target.send("update_node"); //Sometimes targetting an anim.node parent with anim.node children doesn't work (children don't get their transform updated). This solves it for some reason.

			// Apply specific rules depending on if controlling the camera or an object
            if (this.control_obj_type == "cam") {
				this.main_node.movemode = "local";
				this.main_node.turnmode = "local";
				this.pitch_node.turnmode = "parent";
                this.set_flymode(this.flymode);
			} else {
				this.flymode_applyed = false;
				if (controlmode == 0) {
    				// When controlling an object, we convert the translation vector
    				// from screen space to world space in this.move
    				// So we need the cam base matrix
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

        } else if (obj_name == undefined && this.target.name != "") {
            // No target, unbinding previous target
            const world_pos = this.target.send("getworldpos");
            const world_quat = this.target.send("getworldquat");
            const world_scale = this.target.send("getworldscale");
        
            if (this.last_target_anim_node) {
                this.target.send("anim", this.last_target_anim_node);
            } else {
                this.target.send("anim");
            }
            this.target.send("anim_reset");
        
            const local = this.world_to_local(this.last_target_anim_node, world_pos, world_quat);
            this.target.send("position", local.pos);
            this.target.send("quat", local.quat);
            this.target.send("scale", world_scale);
        
            this.last_target_anim_node = null;
            this.target.name = "";
        }
		this.set_bounds();
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
            proxy.send("anim_reset");
            proxy.send("anim", this.camera_node_implicit.name);
            this.camera_node_implicit.transform = transform;
            target = this.camera_node_implicit.name;
        }
        if (target) {
            this.camera_node.name = target;
    		this.camera_node.send("animmode", "world");
            // this.get_cam_base_matrix();
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
            this.get_cam_base_matrix();
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
            this.get_cam_base_matrix();
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
		this.bounds.drawto = v;
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

    set_show_bounds(v) {
        this.show_bounds = v ? 1 : 0;
        this.set_bounds();
    }

    set_bounds() {
        if (this.show_bounds && this.control_obj_type === "obj") {
            switch (this.target_type) {
                case "jit_anim_node":
                    this.bounds.color = [1, 0, 1, 1];
                    break;
                default:
                    this.bounds.color = [1, 1, 1, 1];
                    break;
            }
            this.bounds.enable = 1;
        } else {
            this.bounds.enable = 0;
        }
    }
    
    world_to_local(anim_node_name, world_pos, world_quat) {
        if (!anim_node_name) {
            return { pos: world_pos, quat: world_quat };
        }
        const parent = new JitterObject("jit.proxy");
        parent.name = anim_node_name;
        const pos = parent.send("worldtolocal", world_pos);
        const quat = parent.send("worldtolocal_quat", world_quat);
        parent.freepeer();
        return { pos, quat };
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
        this.cube_indexes.freepeer();
        this.cube_matrix.freepeer();
        this.bounds.freepeer();
        this.dummy_node.freepeer();
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
}

// Select which camera to control
function control_camera(obj_name) {
	if (obj_name !== undefined) {
		const answer = ctlr.control(obj_name, "cam");
		// if (answer) do_show_bounds(0);
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
	ctlr.set_show_bounds(show_bounds);
}
set_show_bounds.local = 1;

function set_controlmode(v) {
    const new_val = v > 0 ? 1 : 0;
    if (controlmode === new_val) return;
    controlmode = new_val;
    ctlr.control(ctlr.target.name, ctlr.control_obj_type);
}

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

function is_controllable(obj_class) {
	// Using jit.proxy syntax (ie 'jit_gl_mesh' and not 'jit.gl.mesh')
	return ANIMABLE_GL_OBJECTS.includes(obj_class);
}
is_controllable.local = 1;

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
        default:
        //     post(event.args); post();
            break;
    }
}
ctx_callback.local = 1;

function dosetdrawto(arg) {
	if (arg === drawto || !arg) {
		// bounce
		return;
	}

	drawto = arg;
	ctlr.set_drawto(drawto);
	ctx_proxy.name = drawto;
	
}
dosetdrawto.local = 1;
