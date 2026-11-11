import * as _isFormatEmail_1 from "typia/lib/internal/_isFormatEmail";
import * as _isTypeInt32_1 from "typia/lib/internal/_isTypeInt32";
import * as _stringLengthGte_1 from "typia/lib/internal/_stringLengthGte";
import * as _accessExpressionAsString_1 from "typia/lib/internal/_accessExpressionAsString";
import * as _validateReport_1 from "typia/lib/internal/_validateReport";
import * as _createStandardSchema_1 from "typia/lib/internal/_createStandardSchema";
// The flat validator alone, for the bundle size and cold start of Typia (see ../../entries/typia.ts).
import typia from "typia";
export const flat = (() => {
    const _io0 = (input, _exceptionable = true) => "string" === typeof input.name && _stringLengthGte_1._stringLengthGte(input.name, 3) && ("string" === typeof input.email && _isFormatEmail_1._isFormatEmail(input.email)) && ("number" === typeof input.age && (_isTypeInt32_1._isTypeInt32(input.age) && 0 <= input.age)) && (3 === Object.keys(input).length || Object.keys(input).every(key => {
        if (["name", "email", "age"].some(prop => key === prop))
            return true;
        const value = input[key];
        if (undefined === value)
            return true;
        return false;
    }));
    const _vo0 = (input, _path, _exceptionable = true) => ["string" === typeof input.name && (_stringLengthGte_1._stringLengthGte(input.name, 3) || _report(_exceptionable, {
            path: _path + ".name",
            expected: "string & MinLength<3>",
            value: input.name
        })) || _report(_exceptionable, {
            path: _path + ".name",
            expected: "(string & MinLength<3>)",
            value: input.name
        }), "string" === typeof input.email && (_isFormatEmail_1._isFormatEmail(input.email) || _report(_exceptionable, {
            path: _path + ".email",
            expected: "string & Format<\"email\">",
            value: input.email
        })) || _report(_exceptionable, {
            path: _path + ".email",
            expected: "(string & Format<\"email\">)",
            value: input.email
        }), "number" === typeof input.age && (_isTypeInt32_1._isTypeInt32(input.age) || _report(_exceptionable, {
            path: _path + ".age",
            expected: "number & Type<\"int32\">",
            value: input.age
        })) && (0 <= input.age || _report(_exceptionable, {
            path: _path + ".age",
            expected: "number & Minimum<0>",
            value: input.age
        })) || _report(_exceptionable, {
            path: _path + ".age",
            expected: "(number & Type<\"int32\"> & Minimum<0>)",
            value: input.age
        }), 3 === Object.keys(input).length || (false === _exceptionable || Object.keys(input).map(key => {
            if (["name", "email", "age"].some(prop => key === prop))
                return true;
            const value = input[key];
            if (undefined === value)
                return true;
            return _report(_exceptionable, {
                path: _path + _accessExpressionAsString_1._accessExpressionAsString(key),
                expected: "undefined",
                value: value,
                description: [
                    `The property \`${key}\` is not defined in the object type.`,
                    "",
                    "Please remove the property next time."
                ].join("\n")
            });
        }).every(flag => flag))].every(flag => flag);
    const __is = (input, _exceptionable = true) => "object" === typeof input && null !== input && _io0(input, true);
    let errors;
    let _report;
    return _createStandardSchema_1._createStandardSchema(input => {
        if (false === __is(input)) {
            errors = [];
            _report = _validateReport_1._validateReport(errors);
            ((input, _path, _exceptionable = true) => ("object" === typeof input && null !== input || _report(true, {
                path: _path + "",
                expected: "Flat",
                value: input
            })) && _vo0(input, _path + "", true) || _report(true, {
                path: _path + "",
                expected: "Flat",
                value: input
            }))(input, "$input", true);
            const success = 0 === errors.length;
            return success ? {
                success,
                data: input
            } : {
                success,
                errors,
                data: input
            };
        }
        return {
            success: true,
            data: input
        };
    });
})();
