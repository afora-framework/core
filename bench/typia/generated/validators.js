import * as _isFormatEmail_1 from "typia/lib/internal/_isFormatEmail";
import * as _isTypeInt32_1 from "typia/lib/internal/_isTypeInt32";
import * as _isFormatUuid_1 from "typia/lib/internal/_isFormatUuid";
import * as _isFormatDateTime_1 from "typia/lib/internal/_isFormatDateTime";
import * as _stringLengthGte_1 from "typia/lib/internal/_stringLengthGte";
import * as _accessExpressionAsString_1 from "typia/lib/internal/_accessExpressionAsString";
import * as _stringLengthLte_1 from "typia/lib/internal/_stringLengthLte";
import * as _validateReport_1 from "typia/lib/internal/_validateReport";
import * as _createStandardSchema_1 from "typia/lib/internal/_createStandardSchema";
// Typia makes its validators at build time, from the types below. `bun run
// typia` (ttsc, which needs Go) compiles this file to ../generated, which is
// committed, so that running the benchmark needs neither. Typia has no
// transforms, so these are the shapes of the clean values; `validateEquals`
// rejects undeclared keys, like every other contender.
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
export const nested = (() => {
    const _io0 = (input, _exceptionable = true) => "string" === typeof input.name && _stringLengthGte_1._stringLengthGte(input.name, 3) && ("string" === typeof input.email && _isFormatEmail_1._isFormatEmail(input.email)) && ("number" === typeof input.age && (_isTypeInt32_1._isTypeInt32(input.age) && 0 <= input.age)) && ("object" === typeof input.address && null !== input.address && _io2(input.address, true && _exceptionable)) && (Array.isArray(input.tags) && (input.tags.length <= 5 && input.tags.every((elem, _index1) => "string" === typeof elem && _stringLengthGte_1._stringLengthGte(elem, 1)))) && (Array.isArray(input.addresses) && input.addresses.every((elem, _index2) => "object" === typeof elem && null !== elem && _io2(elem, true && _exceptionable))) && (6 === Object.keys(input).length || Object.keys(input).every(key => {
        if (["name", "email", "age", "address", "tags", "addresses"].some(prop => key === prop))
            return true;
        const value = input[key];
        if (undefined === value)
            return true;
        return false;
    }));
    const _io2 = (input, _exceptionable = true) => "string" === typeof input.street && _stringLengthGte_1._stringLengthGte(input.street, 1) && ("string" === typeof input.zip && _stringLengthGte_1._stringLengthGte(input.zip, 5)) && (2 === Object.keys(input).length || Object.keys(input).every(key => {
        if (["street", "zip"].some(prop => key === prop))
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
        }), ("object" === typeof input.address && null !== input.address || _report(_exceptionable, {
            path: _path + ".address",
            expected: "Address",
            value: input.address
        })) && _vo2(input.address, _path + ".address", true && _exceptionable) || _report(_exceptionable, {
            path: _path + ".address",
            expected: "Address",
            value: input.address
        }), (Array.isArray(input.tags) || _report(_exceptionable, {
            path: _path + ".tags",
            expected: "(Array<Text<1>> & MaxItems<5>)",
            value: input.tags
        })) && ((input.tags.length <= 5 || _report(_exceptionable, {
            path: _path + ".tags",
            expected: "Array<> & MaxItems<5>",
            value: input.tags
        })) && input.tags.map((elem, _index3) => "string" === typeof elem && (_stringLengthGte_1._stringLengthGte(elem, 1) || _report(_exceptionable, {
            path: _path + ".tags[" + _index3 + "]",
            expected: "string & MinLength<1>",
            value: elem
        })) || _report(_exceptionable, {
            path: _path + ".tags[" + _index3 + "]",
            expected: "(string & MinLength<1>)",
            value: elem
        })).every(flag => flag)) || _report(_exceptionable, {
            path: _path + ".tags",
            expected: "(Array<Text<1>> & MaxItems<5>)",
            value: input.tags
        }), (Array.isArray(input.addresses) || _report(_exceptionable, {
            path: _path + ".addresses",
            expected: "Array<Address>",
            value: input.addresses
        })) && input.addresses.map((elem, _index4) => ("object" === typeof elem && null !== elem || _report(_exceptionable, {
            path: _path + ".addresses[" + _index4 + "]",
            expected: "Address",
            value: elem
        })) && _vo2(elem, _path + ".addresses[" + _index4 + "]", true && _exceptionable) || _report(_exceptionable, {
            path: _path + ".addresses[" + _index4 + "]",
            expected: "Address",
            value: elem
        })).every(flag => flag) || _report(_exceptionable, {
            path: _path + ".addresses",
            expected: "Array<Address>",
            value: input.addresses
        }), 6 === Object.keys(input).length || (false === _exceptionable || Object.keys(input).map(key => {
            if (["name", "email", "age", "address", "tags", "addresses"].some(prop => key === prop))
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
    const _vo2 = (input, _path, _exceptionable = true) => ["string" === typeof input.street && (_stringLengthGte_1._stringLengthGte(input.street, 1) || _report(_exceptionable, {
            path: _path + ".street",
            expected: "string & MinLength<1>",
            value: input.street
        })) || _report(_exceptionable, {
            path: _path + ".street",
            expected: "(string & MinLength<1>)",
            value: input.street
        }), "string" === typeof input.zip && (_stringLengthGte_1._stringLengthGte(input.zip, 5) || _report(_exceptionable, {
            path: _path + ".zip",
            expected: "string & MinLength<5>",
            value: input.zip
        })) || _report(_exceptionable, {
            path: _path + ".zip",
            expected: "(string & MinLength<5>)",
            value: input.zip
        }), 2 === Object.keys(input).length || (false === _exceptionable || Object.keys(input).map(key => {
            if (["street", "zip"].some(prop => key === prop))
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
                expected: "Nested",
                value: input
            })) && _vo0(input, _path + "", true) || _report(true, {
                path: _path + "",
                expected: "Nested",
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
export const order = (() => {
    const _io0 = (input, _exceptionable = true) => "string" === typeof input.cartId && _isFormatUuid_1._isFormatUuid(input.cartId) && ("cancelled" === input.status || "paid" === input.status || "pending" === input.status || "shipped" === input.status) && ("object" === typeof input.customer && null !== input.customer && _io1(input.customer, true && _exceptionable)) && ("object" === typeof input.shipping && null !== input.shipping && _io2(input.shipping, true && _exceptionable)) && (Array.isArray(input.items) && (1 <= input.items.length && input.items.every((elem, _index1) => "object" === typeof elem && null !== elem && _io3(elem, true && _exceptionable)))) && (undefined === input.coupon || "string" === typeof input.coupon && _stringLengthGte_1._stringLengthGte(input.coupon, 1)) && (undefined === input.notes || "string" === typeof input.notes && _stringLengthLte_1._stringLengthLte(input.notes, 500)) && ("string" === typeof input.placedAt && _isFormatDateTime_1._isFormatDateTime(input.placedAt)) && (6 === Object.keys(input).length || Object.keys(input).every(key => {
        if (["cartId", "status", "customer", "shipping", "items", "coupon", "notes", "placedAt"].some(prop => key === prop))
            return true;
        const value = input[key];
        if (undefined === value)
            return true;
        return false;
    }));
    const _io1 = (input, _exceptionable = true) => "string" === typeof input.name && _stringLengthGte_1._stringLengthGte(input.name, 2) && ("string" === typeof input.email && _isFormatEmail_1._isFormatEmail(input.email)) && (undefined === input.phone || "string" === typeof input.phone && _stringLengthGte_1._stringLengthGte(input.phone, 8)) && (2 === Object.keys(input).length || Object.keys(input).every(key => {
        if (["name", "email", "phone"].some(prop => key === prop))
            return true;
        const value = input[key];
        if (undefined === value)
            return true;
        return false;
    }));
    const _io2 = (input, _exceptionable = true) => "string" === typeof input.street && _stringLengthGte_1._stringLengthGte(input.street, 1) && ("string" === typeof input.city && _stringLengthGte_1._stringLengthGte(input.city, 1)) && ("string" === typeof input.zip && _stringLengthGte_1._stringLengthGte(input.zip, 5)) && ("string" === typeof input.country && (_stringLengthGte_1._stringLengthGte(input.country, 2) && _stringLengthLte_1._stringLengthLte(input.country, 2))) && (4 === Object.keys(input).length || Object.keys(input).every(key => {
        if (["street", "city", "zip", "country"].some(prop => key === prop))
            return true;
        const value = input[key];
        if (undefined === value)
            return true;
        return false;
    }));
    const _io3 = (input, _exceptionable = true) => "string" === typeof input.sku && _stringLengthGte_1._stringLengthGte(input.sku, 3) && ("string" === typeof input.name && _stringLengthGte_1._stringLengthGte(input.name, 1)) && ("number" === typeof input.quantity && (_isTypeInt32_1._isTypeInt32(input.quantity) && 1 <= input.quantity)) && ("number" === typeof input.price && 0 <= input.price) && (4 === Object.keys(input).length || Object.keys(input).every(key => {
        if (["sku", "name", "quantity", "price"].some(prop => key === prop))
            return true;
        const value = input[key];
        if (undefined === value)
            return true;
        return false;
    }));
    const _vo0 = (input, _path, _exceptionable = true) => ["string" === typeof input.cartId && (_isFormatUuid_1._isFormatUuid(input.cartId) || _report(_exceptionable, {
            path: _path + ".cartId",
            expected: "string & Format<\"uuid\">",
            value: input.cartId
        })) || _report(_exceptionable, {
            path: _path + ".cartId",
            expected: "(string & Format<\"uuid\">)",
            value: input.cartId
        }), "cancelled" === input.status || "paid" === input.status || "pending" === input.status || "shipped" === input.status || _report(_exceptionable, {
            path: _path + ".status",
            expected: "(\"cancelled\" | \"paid\" | \"pending\" | \"shipped\")",
            value: input.status
        }), ("object" === typeof input.customer && null !== input.customer || _report(_exceptionable, {
            path: _path + ".customer",
            expected: "{ name: Text<2>; email: Email; phone?: Text<8> | undefined; }",
            value: input.customer
        })) && _vo1(input.customer, _path + ".customer", true && _exceptionable) || _report(_exceptionable, {
            path: _path + ".customer",
            expected: "{ name: Text<2>; email: Email; phone?: Text<8> | undefined; }",
            value: input.customer
        }), ("object" === typeof input.shipping && null !== input.shipping || _report(_exceptionable, {
            path: _path + ".shipping",
            expected: "{ street: Text<1>; city: Text<1>; zip: Text<5>; country: string & MinLength<2> & MaxLength<2>; }",
            value: input.shipping
        })) && _vo2(input.shipping, _path + ".shipping", true && _exceptionable) || _report(_exceptionable, {
            path: _path + ".shipping",
            expected: "{ street: Text<1>; city: Text<1>; zip: Text<5>; country: string & MinLength<2> & MaxLength<2>; }",
            value: input.shipping
        }), (Array.isArray(input.items) || _report(_exceptionable, {
            path: _path + ".items",
            expected: "({ sku: Text<3>; name: Text<1>; quantity: Int<1>; price: number & Minimum<0>; }[] & MinItems<1>)",
            value: input.items
        })) && ((1 <= input.items.length || _report(_exceptionable, {
            path: _path + ".items",
            expected: "Array<> & MinItems<1>",
            value: input.items
        })) && input.items.map((elem, _index2) => ("object" === typeof elem && null !== elem || _report(_exceptionable, {
            path: _path + ".items[" + _index2 + "]",
            expected: "{ sku: Text<3>; name: Text<1>; quantity: Int<1>; price: number & Minimum<0>; }",
            value: elem
        })) && _vo3(elem, _path + ".items[" + _index2 + "]", true && _exceptionable) || _report(_exceptionable, {
            path: _path + ".items[" + _index2 + "]",
            expected: "{ sku: Text<3>; name: Text<1>; quantity: Int<1>; price: number & Minimum<0>; }",
            value: elem
        })).every(flag => flag)) || _report(_exceptionable, {
            path: _path + ".items",
            expected: "({ sku: Text<3>; name: Text<1>; quantity: Int<1>; price: number & Minimum<0>; }[] & MinItems<1>)",
            value: input.items
        }), undefined === input.coupon || "string" === typeof input.coupon && (_stringLengthGte_1._stringLengthGte(input.coupon, 1) || _report(_exceptionable, {
            path: _path + ".coupon",
            expected: "string & MinLength<1>",
            value: input.coupon
        })) || _report(_exceptionable, {
            path: _path + ".coupon",
            expected: "((string & MinLength<1>) | undefined)",
            value: input.coupon
        }), undefined === input.notes || "string" === typeof input.notes && (_stringLengthLte_1._stringLengthLte(input.notes, 500) || _report(_exceptionable, {
            path: _path + ".notes",
            expected: "string & MaxLength<500>",
            value: input.notes
        })) || _report(_exceptionable, {
            path: _path + ".notes",
            expected: "((string & MaxLength<500>) | undefined)",
            value: input.notes
        }), "string" === typeof input.placedAt && (_isFormatDateTime_1._isFormatDateTime(input.placedAt) || _report(_exceptionable, {
            path: _path + ".placedAt",
            expected: "string & Format<\"date-time\">",
            value: input.placedAt
        })) || _report(_exceptionable, {
            path: _path + ".placedAt",
            expected: "(string & Format<\"date-time\">)",
            value: input.placedAt
        }), 6 === Object.keys(input).length || (false === _exceptionable || Object.keys(input).map(key => {
            if (["cartId", "status", "customer", "shipping", "items", "coupon", "notes", "placedAt"].some(prop => key === prop))
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
    const _vo1 = (input, _path, _exceptionable = true) => ["string" === typeof input.name && (_stringLengthGte_1._stringLengthGte(input.name, 2) || _report(_exceptionable, {
            path: _path + ".name",
            expected: "string & MinLength<2>",
            value: input.name
        })) || _report(_exceptionable, {
            path: _path + ".name",
            expected: "(string & MinLength<2>)",
            value: input.name
        }), "string" === typeof input.email && (_isFormatEmail_1._isFormatEmail(input.email) || _report(_exceptionable, {
            path: _path + ".email",
            expected: "string & Format<\"email\">",
            value: input.email
        })) || _report(_exceptionable, {
            path: _path + ".email",
            expected: "(string & Format<\"email\">)",
            value: input.email
        }), undefined === input.phone || "string" === typeof input.phone && (_stringLengthGte_1._stringLengthGte(input.phone, 8) || _report(_exceptionable, {
            path: _path + ".phone",
            expected: "string & MinLength<8>",
            value: input.phone
        })) || _report(_exceptionable, {
            path: _path + ".phone",
            expected: "((string & MinLength<8>) | undefined)",
            value: input.phone
        }), 2 === Object.keys(input).length || (false === _exceptionable || Object.keys(input).map(key => {
            if (["name", "email", "phone"].some(prop => key === prop))
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
    const _vo2 = (input, _path, _exceptionable = true) => ["string" === typeof input.street && (_stringLengthGte_1._stringLengthGte(input.street, 1) || _report(_exceptionable, {
            path: _path + ".street",
            expected: "string & MinLength<1>",
            value: input.street
        })) || _report(_exceptionable, {
            path: _path + ".street",
            expected: "(string & MinLength<1>)",
            value: input.street
        }), "string" === typeof input.city && (_stringLengthGte_1._stringLengthGte(input.city, 1) || _report(_exceptionable, {
            path: _path + ".city",
            expected: "string & MinLength<1>",
            value: input.city
        })) || _report(_exceptionable, {
            path: _path + ".city",
            expected: "(string & MinLength<1>)",
            value: input.city
        }), "string" === typeof input.zip && (_stringLengthGte_1._stringLengthGte(input.zip, 5) || _report(_exceptionable, {
            path: _path + ".zip",
            expected: "string & MinLength<5>",
            value: input.zip
        })) || _report(_exceptionable, {
            path: _path + ".zip",
            expected: "(string & MinLength<5>)",
            value: input.zip
        }), "string" === typeof input.country && (_stringLengthGte_1._stringLengthGte(input.country, 2) || _report(_exceptionable, {
            path: _path + ".country",
            expected: "string & MinLength<2>",
            value: input.country
        })) && (_stringLengthLte_1._stringLengthLte(input.country, 2) || _report(_exceptionable, {
            path: _path + ".country",
            expected: "string & MaxLength<2>",
            value: input.country
        })) || _report(_exceptionable, {
            path: _path + ".country",
            expected: "(string & MinLength<2> & MaxLength<2>)",
            value: input.country
        }), 4 === Object.keys(input).length || (false === _exceptionable || Object.keys(input).map(key => {
            if (["street", "city", "zip", "country"].some(prop => key === prop))
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
    const _vo3 = (input, _path, _exceptionable = true) => ["string" === typeof input.sku && (_stringLengthGte_1._stringLengthGte(input.sku, 3) || _report(_exceptionable, {
            path: _path + ".sku",
            expected: "string & MinLength<3>",
            value: input.sku
        })) || _report(_exceptionable, {
            path: _path + ".sku",
            expected: "(string & MinLength<3>)",
            value: input.sku
        }), "string" === typeof input.name && (_stringLengthGte_1._stringLengthGte(input.name, 1) || _report(_exceptionable, {
            path: _path + ".name",
            expected: "string & MinLength<1>",
            value: input.name
        })) || _report(_exceptionable, {
            path: _path + ".name",
            expected: "(string & MinLength<1>)",
            value: input.name
        }), "number" === typeof input.quantity && (_isTypeInt32_1._isTypeInt32(input.quantity) || _report(_exceptionable, {
            path: _path + ".quantity",
            expected: "number & Type<\"int32\">",
            value: input.quantity
        })) && (1 <= input.quantity || _report(_exceptionable, {
            path: _path + ".quantity",
            expected: "number & Minimum<1>",
            value: input.quantity
        })) || _report(_exceptionable, {
            path: _path + ".quantity",
            expected: "(number & Type<\"int32\"> & Minimum<1>)",
            value: input.quantity
        }), "number" === typeof input.price && (0 <= input.price || _report(_exceptionable, {
            path: _path + ".price",
            expected: "number & Minimum<0>",
            value: input.price
        })) || _report(_exceptionable, {
            path: _path + ".price",
            expected: "(number & Minimum<0>)",
            value: input.price
        }), 4 === Object.keys(input).length || (false === _exceptionable || Object.keys(input).map(key => {
            if (["sku", "name", "quantity", "price"].some(prop => key === prop))
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
                expected: "Order",
                value: input
            })) && _vo0(input, _path + "", true) || _report(true, {
                path: _path + "",
                expected: "Order",
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
export const list = (() => {
    const _io0 = (input, _exceptionable = true) => Array.isArray(input.items) && input.items.every((elem, _index1) => "object" === typeof elem && null !== elem && _io1(elem, true && _exceptionable)) && (1 === Object.keys(input).length || Object.keys(input).every(key => {
        if (["items"].some(prop => key === prop))
            return true;
        const value = input[key];
        if (undefined === value)
            return true;
        return false;
    }));
    const _io1 = (input, _exceptionable = true) => "number" === typeof input.position && (_isTypeInt32_1._isTypeInt32(input.position) && 0 <= input.position) && ("string" === typeof input.label && _stringLengthGte_1._stringLengthGte(input.label, 1)) && "boolean" === typeof input.active && (3 === Object.keys(input).length || Object.keys(input).every(key => {
        if (["position", "label", "active"].some(prop => key === prop))
            return true;
        const value = input[key];
        if (undefined === value)
            return true;
        return false;
    }));
    const _vo0 = (input, _path, _exceptionable = true) => [(Array.isArray(input.items) || _report(_exceptionable, {
            path: _path + ".items",
            expected: "{ position: Int<0>; label: Text<1>; active: boolean; }[]",
            value: input.items
        })) && input.items.map((elem, _index2) => ("object" === typeof elem && null !== elem || _report(_exceptionable, {
            path: _path + ".items[" + _index2 + "]",
            expected: "{ position: Int<0>; label: Text<1>; active: boolean; }",
            value: elem
        })) && _vo1(elem, _path + ".items[" + _index2 + "]", true && _exceptionable) || _report(_exceptionable, {
            path: _path + ".items[" + _index2 + "]",
            expected: "{ position: Int<0>; label: Text<1>; active: boolean; }",
            value: elem
        })).every(flag => flag) || _report(_exceptionable, {
            path: _path + ".items",
            expected: "{ position: Int<0>; label: Text<1>; active: boolean; }[]",
            value: input.items
        }), 1 === Object.keys(input).length || (false === _exceptionable || Object.keys(input).map(key => {
            if (["items"].some(prop => key === prop))
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
    const _vo1 = (input, _path, _exceptionable = true) => ["number" === typeof input.position && (_isTypeInt32_1._isTypeInt32(input.position) || _report(_exceptionable, {
            path: _path + ".position",
            expected: "number & Type<\"int32\">",
            value: input.position
        })) && (0 <= input.position || _report(_exceptionable, {
            path: _path + ".position",
            expected: "number & Minimum<0>",
            value: input.position
        })) || _report(_exceptionable, {
            path: _path + ".position",
            expected: "(number & Type<\"int32\"> & Minimum<0>)",
            value: input.position
        }), "string" === typeof input.label && (_stringLengthGte_1._stringLengthGte(input.label, 1) || _report(_exceptionable, {
            path: _path + ".label",
            expected: "string & MinLength<1>",
            value: input.label
        })) || _report(_exceptionable, {
            path: _path + ".label",
            expected: "(string & MinLength<1>)",
            value: input.label
        }), "boolean" === typeof input.active || _report(_exceptionable, {
            path: _path + ".active",
            expected: "boolean",
            value: input.active
        }), 3 === Object.keys(input).length || (false === _exceptionable || Object.keys(input).map(key => {
            if (["position", "label", "active"].some(prop => key === prop))
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
                expected: "List",
                value: input
            })) && _vo0(input, _path + "", true) || _report(true, {
                path: _path + "",
                expected: "List",
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
export const events = (() => {
    const _ve0 = "({ type: \"click\"; x: Int<0>; y: Int<0>; } | { type: \"purchase\"; orderId: Text<1>; amount: number & Minimum<0>; currency: string & MinLength<3> & MaxLength<3>; } | { type: \"signup\"; email: Email; plan: \"free\" | \"pro\"; } | { type: \"view\"; url: Text<1>; durationMs: Int<0>; })";
    const _ve1 = "({ type: \"click\"; x: Int<0>; y: Int<0>; } | { type: \"view\"; url: Text<1>; durationMs: Int<0>; } | { type: \"purchase\"; orderId: Text<1>; amount: number & Minimum<0>; currency: string & MinLength<3> & MaxLength<3>; } | { type: \"signup\"; email: Email; plan: \"free\" | \"pro\"; })";
    const _io0 = (input, _exceptionable = true) => Array.isArray(input.events) && input.events.every((elem, _index1) => "object" === typeof elem && null !== elem && _iu0(elem, true && _exceptionable)) && (1 === Object.keys(input).length || Object.keys(input).every(key => {
        if (["events"].some(prop => key === prop))
            return true;
        const value = input[key];
        if (undefined === value)
            return true;
        return false;
    }));
    const _io1 = (input, _exceptionable = true) => "click" === input.type && ("number" === typeof input.x && (_isTypeInt32_1._isTypeInt32(input.x) && 0 <= input.x)) && ("number" === typeof input.y && (_isTypeInt32_1._isTypeInt32(input.y) && 0 <= input.y)) && (3 === Object.keys(input).length || Object.keys(input).every(key => {
        if (["type", "x", "y"].some(prop => key === prop))
            return true;
        const value = input[key];
        if (undefined === value)
            return true;
        return false;
    }));
    const _io2 = (input, _exceptionable = true) => "view" === input.type && ("string" === typeof input.url && _stringLengthGte_1._stringLengthGte(input.url, 1)) && ("number" === typeof input.durationMs && (_isTypeInt32_1._isTypeInt32(input.durationMs) && 0 <= input.durationMs)) && (3 === Object.keys(input).length || Object.keys(input).every(key => {
        if (["type", "url", "durationMs"].some(prop => key === prop))
            return true;
        const value = input[key];
        if (undefined === value)
            return true;
        return false;
    }));
    const _io3 = (input, _exceptionable = true) => "purchase" === input.type && ("string" === typeof input.orderId && _stringLengthGte_1._stringLengthGte(input.orderId, 1)) && ("number" === typeof input.amount && 0 <= input.amount) && ("string" === typeof input.currency && (_stringLengthGte_1._stringLengthGte(input.currency, 3) && _stringLengthLte_1._stringLengthLte(input.currency, 3))) && (4 === Object.keys(input).length || Object.keys(input).every(key => {
        if (["type", "orderId", "amount", "currency"].some(prop => key === prop))
            return true;
        const value = input[key];
        if (undefined === value)
            return true;
        return false;
    }));
    const _io4 = (input, _exceptionable = true) => "signup" === input.type && ("string" === typeof input.email && _isFormatEmail_1._isFormatEmail(input.email)) && ("free" === input.plan || "pro" === input.plan) && (3 === Object.keys(input).length || Object.keys(input).every(key => {
        if (["type", "email", "plan"].some(prop => key === prop))
            return true;
        const value = input[key];
        if (undefined === value)
            return true;
        return false;
    }));
    const _iu0 = (input, _exceptionable = true) => (() => {
        if ("click" === input.type)
            return _io1(input, true && _exceptionable);
        else if ("view" === input.type)
            return _io2(input, true && _exceptionable);
        else if ("purchase" === input.type)
            return _io3(input, true && _exceptionable);
        else if ("signup" === input.type)
            return _io4(input, true && _exceptionable);
        else
            return false;
    })();
    const _vo0 = (input, _path, _exceptionable = true) => [(Array.isArray(input.events) || _report(_exceptionable, {
            path: _path + ".events",
            expected: "Array<Event>",
            value: input.events
        })) && input.events.map((elem, _index2) => ("object" === typeof elem && null !== elem || _report(_exceptionable, {
            path: _path + ".events[" + _index2 + "]",
            expected: _ve0,
            value: elem
        })) && _vu0(elem, _path + ".events[" + _index2 + "]", true && _exceptionable) || _report(_exceptionable, {
            path: _path + ".events[" + _index2 + "]",
            expected: _ve0,
            value: elem
        })).every(flag => flag) || _report(_exceptionable, {
            path: _path + ".events",
            expected: "Array<Event>",
            value: input.events
        }), 1 === Object.keys(input).length || (false === _exceptionable || Object.keys(input).map(key => {
            if (["events"].some(prop => key === prop))
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
    const _vo1 = (input, _path, _exceptionable = true) => ["click" === input.type || _report(_exceptionable, {
            path: _path + ".type",
            expected: "\"click\"",
            value: input.type
        }), "number" === typeof input.x && (_isTypeInt32_1._isTypeInt32(input.x) || _report(_exceptionable, {
            path: _path + ".x",
            expected: "number & Type<\"int32\">",
            value: input.x
        })) && (0 <= input.x || _report(_exceptionable, {
            path: _path + ".x",
            expected: "number & Minimum<0>",
            value: input.x
        })) || _report(_exceptionable, {
            path: _path + ".x",
            expected: "(number & Type<\"int32\"> & Minimum<0>)",
            value: input.x
        }), "number" === typeof input.y && (_isTypeInt32_1._isTypeInt32(input.y) || _report(_exceptionable, {
            path: _path + ".y",
            expected: "number & Type<\"int32\">",
            value: input.y
        })) && (0 <= input.y || _report(_exceptionable, {
            path: _path + ".y",
            expected: "number & Minimum<0>",
            value: input.y
        })) || _report(_exceptionable, {
            path: _path + ".y",
            expected: "(number & Type<\"int32\"> & Minimum<0>)",
            value: input.y
        }), 3 === Object.keys(input).length || (false === _exceptionable || Object.keys(input).map(key => {
            if (["type", "x", "y"].some(prop => key === prop))
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
    const _vo2 = (input, _path, _exceptionable = true) => ["view" === input.type || _report(_exceptionable, {
            path: _path + ".type",
            expected: "\"view\"",
            value: input.type
        }), "string" === typeof input.url && (_stringLengthGte_1._stringLengthGte(input.url, 1) || _report(_exceptionable, {
            path: _path + ".url",
            expected: "string & MinLength<1>",
            value: input.url
        })) || _report(_exceptionable, {
            path: _path + ".url",
            expected: "(string & MinLength<1>)",
            value: input.url
        }), "number" === typeof input.durationMs && (_isTypeInt32_1._isTypeInt32(input.durationMs) || _report(_exceptionable, {
            path: _path + ".durationMs",
            expected: "number & Type<\"int32\">",
            value: input.durationMs
        })) && (0 <= input.durationMs || _report(_exceptionable, {
            path: _path + ".durationMs",
            expected: "number & Minimum<0>",
            value: input.durationMs
        })) || _report(_exceptionable, {
            path: _path + ".durationMs",
            expected: "(number & Type<\"int32\"> & Minimum<0>)",
            value: input.durationMs
        }), 3 === Object.keys(input).length || (false === _exceptionable || Object.keys(input).map(key => {
            if (["type", "url", "durationMs"].some(prop => key === prop))
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
    const _vo3 = (input, _path, _exceptionable = true) => ["purchase" === input.type || _report(_exceptionable, {
            path: _path + ".type",
            expected: "\"purchase\"",
            value: input.type
        }), "string" === typeof input.orderId && (_stringLengthGte_1._stringLengthGte(input.orderId, 1) || _report(_exceptionable, {
            path: _path + ".orderId",
            expected: "string & MinLength<1>",
            value: input.orderId
        })) || _report(_exceptionable, {
            path: _path + ".orderId",
            expected: "(string & MinLength<1>)",
            value: input.orderId
        }), "number" === typeof input.amount && (0 <= input.amount || _report(_exceptionable, {
            path: _path + ".amount",
            expected: "number & Minimum<0>",
            value: input.amount
        })) || _report(_exceptionable, {
            path: _path + ".amount",
            expected: "(number & Minimum<0>)",
            value: input.amount
        }), "string" === typeof input.currency && (_stringLengthGte_1._stringLengthGte(input.currency, 3) || _report(_exceptionable, {
            path: _path + ".currency",
            expected: "string & MinLength<3>",
            value: input.currency
        })) && (_stringLengthLte_1._stringLengthLte(input.currency, 3) || _report(_exceptionable, {
            path: _path + ".currency",
            expected: "string & MaxLength<3>",
            value: input.currency
        })) || _report(_exceptionable, {
            path: _path + ".currency",
            expected: "(string & MinLength<3> & MaxLength<3>)",
            value: input.currency
        }), 4 === Object.keys(input).length || (false === _exceptionable || Object.keys(input).map(key => {
            if (["type", "orderId", "amount", "currency"].some(prop => key === prop))
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
    const _vo4 = (input, _path, _exceptionable = true) => ["signup" === input.type || _report(_exceptionable, {
            path: _path + ".type",
            expected: "\"signup\"",
            value: input.type
        }), "string" === typeof input.email && (_isFormatEmail_1._isFormatEmail(input.email) || _report(_exceptionable, {
            path: _path + ".email",
            expected: "string & Format<\"email\">",
            value: input.email
        })) || _report(_exceptionable, {
            path: _path + ".email",
            expected: "(string & Format<\"email\">)",
            value: input.email
        }), "free" === input.plan || "pro" === input.plan || _report(_exceptionable, {
            path: _path + ".plan",
            expected: "(\"free\" | \"pro\")",
            value: input.plan
        }), 3 === Object.keys(input).length || (false === _exceptionable || Object.keys(input).map(key => {
            if (["type", "email", "plan"].some(prop => key === prop))
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
    const _vu0 = (input, _path, _exceptionable = true) => (() => {
        if ("click" === input.type)
            return _vo1(input, _path, true && _exceptionable);
        else if ("view" === input.type)
            return _vo2(input, _path, true && _exceptionable);
        else if ("purchase" === input.type)
            return _vo3(input, _path, true && _exceptionable);
        else if ("signup" === input.type)
            return _vo4(input, _path, true && _exceptionable);
        else
            return _report(_exceptionable, {
                path: _path,
                expected: _ve1,
                value: input
            });
    })();
    const __is = (input, _exceptionable = true) => "object" === typeof input && null !== input && _io0(input, true);
    let errors;
    let _report;
    return _createStandardSchema_1._createStandardSchema(input => {
        if (false === __is(input)) {
            errors = [];
            _report = _validateReport_1._validateReport(errors);
            ((input, _path, _exceptionable = true) => ("object" === typeof input && null !== input || _report(true, {
                path: _path + "",
                expected: "Events",
                value: input
            })) && _vo0(input, _path + "", true) || _report(true, {
                path: _path + "",
                expected: "Events",
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
export const deep = (() => {
    const _io0 = (input, _exceptionable = true) => "string" === typeof input.name && _stringLengthGte_1._stringLengthGte(input.name, 1) && ("number" === typeof input.count && (_isTypeInt32_1._isTypeInt32(input.count) && 0 <= input.count)) && ("object" === typeof input.child && null !== input.child && _io1(input.child, true && _exceptionable)) && (3 === Object.keys(input).length || Object.keys(input).every(key => {
        if (["name", "count", "child"].some(prop => key === prop))
            return true;
        const value = input[key];
        if (undefined === value)
            return true;
        return false;
    }));
    const _io1 = (input, _exceptionable = true) => "string" === typeof input.name && _stringLengthGte_1._stringLengthGte(input.name, 1) && ("number" === typeof input.count && (_isTypeInt32_1._isTypeInt32(input.count) && 0 <= input.count)) && ("object" === typeof input.child && null !== input.child && _io2(input.child, true && _exceptionable)) && (3 === Object.keys(input).length || Object.keys(input).every(key => {
        if (["name", "count", "child"].some(prop => key === prop))
            return true;
        const value = input[key];
        if (undefined === value)
            return true;
        return false;
    }));
    const _io2 = (input, _exceptionable = true) => "string" === typeof input.name && _stringLengthGte_1._stringLengthGte(input.name, 1) && ("number" === typeof input.count && (_isTypeInt32_1._isTypeInt32(input.count) && 0 <= input.count)) && ("object" === typeof input.child && null !== input.child && _io3(input.child, true && _exceptionable)) && (3 === Object.keys(input).length || Object.keys(input).every(key => {
        if (["name", "count", "child"].some(prop => key === prop))
            return true;
        const value = input[key];
        if (undefined === value)
            return true;
        return false;
    }));
    const _io3 = (input, _exceptionable = true) => "string" === typeof input.name && _stringLengthGte_1._stringLengthGte(input.name, 1) && ("number" === typeof input.count && (_isTypeInt32_1._isTypeInt32(input.count) && 0 <= input.count)) && ("object" === typeof input.child && null !== input.child && _io4(input.child, true && _exceptionable)) && (3 === Object.keys(input).length || Object.keys(input).every(key => {
        if (["name", "count", "child"].some(prop => key === prop))
            return true;
        const value = input[key];
        if (undefined === value)
            return true;
        return false;
    }));
    const _io4 = (input, _exceptionable = true) => "string" === typeof input.name && _stringLengthGte_1._stringLengthGte(input.name, 1) && ("number" === typeof input.count && (_isTypeInt32_1._isTypeInt32(input.count) && 0 <= input.count)) && ("object" === typeof input.child && null !== input.child && _io5(input.child, true && _exceptionable)) && (3 === Object.keys(input).length || Object.keys(input).every(key => {
        if (["name", "count", "child"].some(prop => key === prop))
            return true;
        const value = input[key];
        if (undefined === value)
            return true;
        return false;
    }));
    const _io5 = (input, _exceptionable = true) => "string" === typeof input.name && _stringLengthGte_1._stringLengthGte(input.name, 1) && ("number" === typeof input.count && (_isTypeInt32_1._isTypeInt32(input.count) && 0 <= input.count)) && (2 === Object.keys(input).length || Object.keys(input).every(key => {
        if (["name", "count"].some(prop => key === prop))
            return true;
        const value = input[key];
        if (undefined === value)
            return true;
        return false;
    }));
    const _vo0 = (input, _path, _exceptionable = true) => ["string" === typeof input.name && (_stringLengthGte_1._stringLengthGte(input.name, 1) || _report(_exceptionable, {
            path: _path + ".name",
            expected: "string & MinLength<1>",
            value: input.name
        })) || _report(_exceptionable, {
            path: _path + ".name",
            expected: "(string & MinLength<1>)",
            value: input.name
        }), "number" === typeof input.count && (_isTypeInt32_1._isTypeInt32(input.count) || _report(_exceptionable, {
            path: _path + ".count",
            expected: "number & Type<\"int32\">",
            value: input.count
        })) && (0 <= input.count || _report(_exceptionable, {
            path: _path + ".count",
            expected: "number & Minimum<0>",
            value: input.count
        })) || _report(_exceptionable, {
            path: _path + ".count",
            expected: "(number & Type<\"int32\"> & Minimum<0>)",
            value: input.count
        }), ("object" === typeof input.child && null !== input.child || _report(_exceptionable, {
            path: _path + ".child",
            expected: "Level<Level<Level<Level<{ name: Text<1>; count: Int<0>; }>>>>",
            value: input.child
        })) && _vo1(input.child, _path + ".child", true && _exceptionable) || _report(_exceptionable, {
            path: _path + ".child",
            expected: "Level<Level<Level<Level<{ name: Text<1>; count: Int<0>; }>>>>",
            value: input.child
        }), 3 === Object.keys(input).length || (false === _exceptionable || Object.keys(input).map(key => {
            if (["name", "count", "child"].some(prop => key === prop))
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
    const _vo1 = (input, _path, _exceptionable = true) => ["string" === typeof input.name && (_stringLengthGte_1._stringLengthGte(input.name, 1) || _report(_exceptionable, {
            path: _path + ".name",
            expected: "string & MinLength<1>",
            value: input.name
        })) || _report(_exceptionable, {
            path: _path + ".name",
            expected: "(string & MinLength<1>)",
            value: input.name
        }), "number" === typeof input.count && (_isTypeInt32_1._isTypeInt32(input.count) || _report(_exceptionable, {
            path: _path + ".count",
            expected: "number & Type<\"int32\">",
            value: input.count
        })) && (0 <= input.count || _report(_exceptionable, {
            path: _path + ".count",
            expected: "number & Minimum<0>",
            value: input.count
        })) || _report(_exceptionable, {
            path: _path + ".count",
            expected: "(number & Type<\"int32\"> & Minimum<0>)",
            value: input.count
        }), ("object" === typeof input.child && null !== input.child || _report(_exceptionable, {
            path: _path + ".child",
            expected: "Level<Level<Level<{ name: Text<1>; count: Int<0>; }>>>",
            value: input.child
        })) && _vo2(input.child, _path + ".child", true && _exceptionable) || _report(_exceptionable, {
            path: _path + ".child",
            expected: "Level<Level<Level<{ name: Text<1>; count: Int<0>; }>>>",
            value: input.child
        }), 3 === Object.keys(input).length || (false === _exceptionable || Object.keys(input).map(key => {
            if (["name", "count", "child"].some(prop => key === prop))
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
    const _vo2 = (input, _path, _exceptionable = true) => ["string" === typeof input.name && (_stringLengthGte_1._stringLengthGte(input.name, 1) || _report(_exceptionable, {
            path: _path + ".name",
            expected: "string & MinLength<1>",
            value: input.name
        })) || _report(_exceptionable, {
            path: _path + ".name",
            expected: "(string & MinLength<1>)",
            value: input.name
        }), "number" === typeof input.count && (_isTypeInt32_1._isTypeInt32(input.count) || _report(_exceptionable, {
            path: _path + ".count",
            expected: "number & Type<\"int32\">",
            value: input.count
        })) && (0 <= input.count || _report(_exceptionable, {
            path: _path + ".count",
            expected: "number & Minimum<0>",
            value: input.count
        })) || _report(_exceptionable, {
            path: _path + ".count",
            expected: "(number & Type<\"int32\"> & Minimum<0>)",
            value: input.count
        }), ("object" === typeof input.child && null !== input.child || _report(_exceptionable, {
            path: _path + ".child",
            expected: "Level<Level<{ name: Text<1>; count: Int<0>; }>>",
            value: input.child
        })) && _vo3(input.child, _path + ".child", true && _exceptionable) || _report(_exceptionable, {
            path: _path + ".child",
            expected: "Level<Level<{ name: Text<1>; count: Int<0>; }>>",
            value: input.child
        }), 3 === Object.keys(input).length || (false === _exceptionable || Object.keys(input).map(key => {
            if (["name", "count", "child"].some(prop => key === prop))
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
    const _vo3 = (input, _path, _exceptionable = true) => ["string" === typeof input.name && (_stringLengthGte_1._stringLengthGte(input.name, 1) || _report(_exceptionable, {
            path: _path + ".name",
            expected: "string & MinLength<1>",
            value: input.name
        })) || _report(_exceptionable, {
            path: _path + ".name",
            expected: "(string & MinLength<1>)",
            value: input.name
        }), "number" === typeof input.count && (_isTypeInt32_1._isTypeInt32(input.count) || _report(_exceptionable, {
            path: _path + ".count",
            expected: "number & Type<\"int32\">",
            value: input.count
        })) && (0 <= input.count || _report(_exceptionable, {
            path: _path + ".count",
            expected: "number & Minimum<0>",
            value: input.count
        })) || _report(_exceptionable, {
            path: _path + ".count",
            expected: "(number & Type<\"int32\"> & Minimum<0>)",
            value: input.count
        }), ("object" === typeof input.child && null !== input.child || _report(_exceptionable, {
            path: _path + ".child",
            expected: "Level<{ name: Text<1>; count: Int<0>; }>",
            value: input.child
        })) && _vo4(input.child, _path + ".child", true && _exceptionable) || _report(_exceptionable, {
            path: _path + ".child",
            expected: "Level<{ name: Text<1>; count: Int<0>; }>",
            value: input.child
        }), 3 === Object.keys(input).length || (false === _exceptionable || Object.keys(input).map(key => {
            if (["name", "count", "child"].some(prop => key === prop))
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
    const _vo4 = (input, _path, _exceptionable = true) => ["string" === typeof input.name && (_stringLengthGte_1._stringLengthGte(input.name, 1) || _report(_exceptionable, {
            path: _path + ".name",
            expected: "string & MinLength<1>",
            value: input.name
        })) || _report(_exceptionable, {
            path: _path + ".name",
            expected: "(string & MinLength<1>)",
            value: input.name
        }), "number" === typeof input.count && (_isTypeInt32_1._isTypeInt32(input.count) || _report(_exceptionable, {
            path: _path + ".count",
            expected: "number & Type<\"int32\">",
            value: input.count
        })) && (0 <= input.count || _report(_exceptionable, {
            path: _path + ".count",
            expected: "number & Minimum<0>",
            value: input.count
        })) || _report(_exceptionable, {
            path: _path + ".count",
            expected: "(number & Type<\"int32\"> & Minimum<0>)",
            value: input.count
        }), ("object" === typeof input.child && null !== input.child || _report(_exceptionable, {
            path: _path + ".child",
            expected: "{ name: Text<1>; count: Int<0>; }",
            value: input.child
        })) && _vo5(input.child, _path + ".child", true && _exceptionable) || _report(_exceptionable, {
            path: _path + ".child",
            expected: "{ name: Text<1>; count: Int<0>; }",
            value: input.child
        }), 3 === Object.keys(input).length || (false === _exceptionable || Object.keys(input).map(key => {
            if (["name", "count", "child"].some(prop => key === prop))
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
    const _vo5 = (input, _path, _exceptionable = true) => ["string" === typeof input.name && (_stringLengthGte_1._stringLengthGte(input.name, 1) || _report(_exceptionable, {
            path: _path + ".name",
            expected: "string & MinLength<1>",
            value: input.name
        })) || _report(_exceptionable, {
            path: _path + ".name",
            expected: "(string & MinLength<1>)",
            value: input.name
        }), "number" === typeof input.count && (_isTypeInt32_1._isTypeInt32(input.count) || _report(_exceptionable, {
            path: _path + ".count",
            expected: "number & Type<\"int32\">",
            value: input.count
        })) && (0 <= input.count || _report(_exceptionable, {
            path: _path + ".count",
            expected: "number & Minimum<0>",
            value: input.count
        })) || _report(_exceptionable, {
            path: _path + ".count",
            expected: "(number & Type<\"int32\"> & Minimum<0>)",
            value: input.count
        }), 2 === Object.keys(input).length || (false === _exceptionable || Object.keys(input).map(key => {
            if (["name", "count"].some(prop => key === prop))
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
                expected: "Deep",
                value: input
            })) && _vo0(input, _path + "", true) || _report(true, {
                path: _path + "",
                expected: "Deep",
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
