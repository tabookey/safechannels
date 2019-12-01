function validate(baseClass, inst) {
    if (!baseClass.prototype) {
        throw new Error(`${baseClass}: not a class (no "prototype")`)
    }
    if (!inst.__proto__) {
        throw new Error(`${inst}: not an object instance (no "__proto_")`)
    }

    let impl = {}
    errors = []
    Object.getOwnPropertyNames(baseClass.prototype).forEach(name => {
        if (name[0] == '_') return;  //ignore methods starting with "_"
        impl[name] = true;
        if ( inst.abstract ) return;    //a member named "abstract" skip the "missing implementation" check
        if (baseClass.prototype[name] == inst[name]) {
            errors.push("Baseclass method not implemented: " + name)
        }
    })
    Object.getOwnPropertyNames(inst.__proto__).forEach(name => {
        if (name[0] == '_') return;  //ignore methods starting with "_"

        if (!impl[name] && name!='abstract') {
            errors.push("Implemented method not in baseclass: " + name)
        }
    })
    if ( errors )
        throw new Error( "Interface error for "+inst+": \n"+errors.join("\n"))
}

module.exports = validate



