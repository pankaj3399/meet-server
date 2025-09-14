exports.getAgeFromDOB = function(dob){
    const today = new Date()
    const birthDate = new Date(dob);
    return today.getFullYear() - birthDate.getFullYear();
}